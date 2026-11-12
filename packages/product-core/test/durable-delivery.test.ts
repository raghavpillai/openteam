import { describe, expect, test } from "bun:test";
import type { AssetRef, ChannelMessageView } from "@openteam/contracts";
import {
  createDurableSendController,
  DURABLE_SEND_SCHEMA_VERSION,
  type DurableSendJournal,
  type DurableSendRecord,
  durableSendIsInFlight,
  durableSendVisualState,
  type MessageDeliveryAcceptance,
  parseDurableSendJournal,
} from "../src/durable-delivery";

const acceptedMessage = (
  id: string,
  overrides: Partial<ChannelMessageView> = {}
): ChannelMessageView => ({
  id,
  sequence: "1",
  channelId: "channel-1",
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: { type: "text" },
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const input = {
  target: { channelId: "channel-1", conversationId: "conversation-1" },
  payload: { content: "hello", attachments: [] },
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
};

const memoryStorage = (initial: unknown = null) => {
  let value = initial;
  const writes: DurableSendJournal[] = [];
  return {
    storage: {
      read: async () => value,
      write: async (journal: DurableSendJournal) => {
        value = structuredClone(journal);
        writes.push(structuredClone(journal));
      },
    },
    read: () => value,
    writes,
  };
};

describe("durable send controller", () => {
  test("journals before dispatch, accepts with one nonce, and retires on transcript echo", async () => {
    const memory = memoryStorage();
    const dispatches: DurableSendRecord[] = [];
    const controller = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-accepted-1",
      dispatch: async (record) => {
        dispatches.push(record);
        expect(memory.writes.at(-1)?.records[0]?.phase).toBe("dispatching");
        return { message: acceptedMessage("message-1") };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "fatal",
    });

    const prepared = await controller.enqueue(input);
    expect(prepared.nonce).toBe("nonce-accepted-1");
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(dispatches).toHaveLength(1);
    expect(controller.getSnapshot()[0]?.acceptedMessage?.id).toBe("message-1");
    const acceptedRecord = controller.getSnapshot()[0];
    expect(acceptedRecord).toBeDefined();
    if (!acceptedRecord) throw new Error("accepted delivery was not retained");
    expect(durableSendVisualState(acceptedRecord)).toBe("accepted");

    await controller.reconcile([acceptedMessage("message-1")]);
    expect(controller.getSnapshot()).toEqual([]);
    expect(memory.writes.at(-1)?.records).toEqual([]);
  });

  test("restores an offline queue and checks acceptance before retrying", async () => {
    let offline = true;
    let dispatchCount = 0;
    const memory = memoryStorage();
    const first = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-offline-1",
      dispatch: async () => {
        dispatchCount += 1;
        return { message: acceptedMessage("message-offline") };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "offline",
      isTransportDown: () => offline,
    });
    await first.enqueue(input);
    expect(first.getSnapshot()[0]?.phase).toBe("queued");
    expect(dispatchCount).toBe(0);

    offline = false;
    const resolutions: MessageDeliveryAcceptance[] = [{ status: "not_found" }];
    const restored = createDurableSendController("account-1", memory.storage, {
      dispatch: async (record) => {
        dispatchCount += 1;
        expect(record.nonce).toBe("nonce-offline-1");
        return { message: acceptedMessage("message-offline") };
      },
      resolveAcceptance: async () => resolutions.shift() ?? { status: "not_found" },
      classifyError: () => "offline",
      isTransportDown: () => offline,
    });
    await restored.restore();
    await waitFor(() => restored.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(dispatchCount).toBe(1);
    expect(restored.getSnapshot()[0]?.queuedAtMs).not.toBeNull();
  });

  test("expires an unconfirmed send and resends it with a fresh linked nonce", async () => {
    let clock = 1_000;
    let nonceIndex = 0;
    const memory = memoryStorage();
    const controller = createDurableSendController("account-1", memory.storage, {
      now: () => clock,
      ackTimeoutMs: 100,
      createNonce: () => `nonce-retry-${++nonceIndex}`,
      dispatch: async (record) => ({ message: acceptedMessage(`message-${record.nonce}`) }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    const acceptedRecord = controller.getSnapshot()[0];
    expect(acceptedRecord).toBeDefined();
    if (!acceptedRecord) throw new Error("accepted delivery was not retained");
    expect(durableSendIsInFlight(acceptedRecord)).toBe(false);
    clock += 101;
    await controller.expireAcknowledgements();
    await waitFor(() => controller.getSnapshot()[0]?.phase === "failed");
    const failed = controller.getSnapshot()[0];
    expect(failed).toBeDefined();
    if (!failed) throw new Error("failed delivery was not retained");
    expect(failed.failure?.code).toBe("ack_expired");

    const resent = await controller.resendFailed(failed.nonce);
    expect(resent?.nonce).not.toBe(failed.nonce);
    expect(resent?.priorNonces).toContain(failed.nonce);
  });

  test("fails closed on a corrupt or cross-account journal", () => {
    expect(
      parseDurableSendJournal({ schemaVersion: 1, scope: "other", records: [] }, "mine")
    ).toEqual({ schemaVersion: DURABLE_SEND_SCHEMA_VERSION, scope: "mine", records: [] });
    expect(
      parseDurableSendJournal({ schemaVersion: 1, scope: "mine", records: [{}] }, "mine").records
    ).toEqual([]);
  });

  test("durably commits staged attachments before dispatch and then discards local bytes", async () => {
    const memory = memoryStorage();
    const committed: AssetRef = {
      assetId: "a".repeat(64),
      fileName: "offline.png",
      mimeType: "image/png",
      byteSize: 128,
      kind: "image",
    };
    const alreadyUploaded: AssetRef = {
      assetId: "b".repeat(64),
      fileName: "already.txt",
      mimeType: "text/plain",
      byteSize: 32,
      kind: "text",
    };
    const discarded: string[] = [];
    const controller = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-staged-1",
      commitStagedAttachments: async (record) => {
        expect(record.payload.stagedAttachments?.[0]?.stagingId).toBe("stage-file-1");
        return [committed];
      },
      discardStagedAttachments: async (attachments) => {
        discarded.push(...attachments.map(({ stagingId }) => stagingId));
      },
      dispatch: async (record) => {
        expect(record.payload.stagedAttachments).toEqual([]);
        expect(record.payload.attachments).toEqual([committed, alreadyUploaded]);
        expect(memory.writes.at(-1)?.records[0]?.payload.attachments).toEqual([
          committed,
          alreadyUploaded,
        ]);
        return {
          message: acceptedMessage("message-staged", {
            metadata: { type: "text", attachments: [committed, alreadyUploaded] },
          }),
        };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "fatal",
    });

    await controller.enqueue({
      ...input,
      payload: {
        ...input.payload,
        attachments: [alreadyUploaded],
        stagedAttachments: [
          {
            stagingId: "stage-file-1",
            fileName: "offline.png",
            mimeType: "image/png",
            byteSize: 128,
            kind: "image",
            position: 0,
            previewUri: "file:///durable/stage-file-1",
          },
        ],
      },
    });
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(discarded).toEqual(["stage-file-1"]);
  });

});

describe("bounded platform retries", () => {
  test("server acceptance wins at the retry deadline and no extra submission is made", async () => {
    let clock = 1_000, posts = 0, accepted = false;
    const controller = createDurableSendController("deadline-acceptance", memoryStorage().storage, {
      now: () => clock, retryTimeoutMs: 10_000, createNonce: () => "accepted-on-server",
      classifyError: () => "ambiguous",
      resolveAcceptance: async () => accepted
        ? {status: "accepted", message: acceptedMessage("accepted-late"), acceptedAtMs: clock}
        : {status: "not_found"},
      dispatch: async () => { posts++; throw Error("Response lost"); },
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "queued");
    clock = 11_001; accepted = true;
    await controller.expireAcknowledgements();
    expect(controller.getSnapshot()[0]?.phase).toBe("accepted-awaiting-echo");
    expect(posts).toBe(1);
    controller.dispose();
  });
});
