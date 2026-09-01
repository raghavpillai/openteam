import { describe, expect, test } from "bun:test";
import type { AssetRef, ChannelMessageView } from "@openbot/contracts";
import {
  createDurableSendController,
  type DurableSendJournal,
  type DurableSendRecord,
  durableSendIsInFlight,
  durableSendPromptDigest,
  durableSendVisualState,
  type MessageDeliveryAcceptance,
  parseDurableSendJournal,
} from "../src/durable-delivery";

const acceptedMessage = (id: string): ChannelMessageView => ({
  id,
  sequence: "1",
  channelId: "channel-1",
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: { type: "text" },
  createdAt: "2026-09-01T00:00:00.000Z",
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

    await controller.reconcile(new Set(["message-1"]));
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

  test("resolves an ambiguous response as accepted without sending twice", async () => {
    const memory = memoryStorage();
    let dispatchCount = 0;
    const controller = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-ambiguous-1",
      dispatch: async () => {
        dispatchCount += 1;
        throw new Error("socket closed after response");
      },
      resolveAcceptance: async () => ({
        status: "accepted",
        acceptedAtMs: 10,
        message: acceptedMessage("message-ambiguous"),
      }),
      classifyError: () => "ambiguous",
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    await controller.flush();
    expect(dispatchCount).toBe(1);
    expect(controller.getSnapshot()[0]?.acceptedMessage?.id).toBe("message-ambiguous");
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

  test("cancels a never-dispatched queued send and returns its recoverable draft", async () => {
    const memory = memoryStorage();
    const controller = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-cancel-1",
      dispatch: async () => ({ message: acceptedMessage("unused") }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "offline",
      isTransportDown: () => true,
    });
    await controller.enqueue(input);
    const recovered = await controller.cancelQueued("nonce-cancel-1");
    expect(recovered?.content).toBe("hello");
    expect(controller.getSnapshot()).toEqual([]);
  });

  test("fails closed on a corrupt or cross-account journal", () => {
    expect(
      parseDurableSendJournal({ schemaVersion: 1, scope: "other", records: [] }, "mine")
    ).toEqual({ schemaVersion: 1, scope: "mine", records: [] });
    expect(
      parseDurableSendJournal({ schemaVersion: 1, scope: "mine", records: [{}] }, "mine").records
    ).toEqual([]);
  });

  test("does not label an online head-of-line wait as sent while offline and drains immediately", async () => {
    const firstAccepted = deferred<{ message: ChannelMessageView }>();
    const dispatched: string[] = [];
    let nonceIndex = 0;
    const controller = createDurableSendController("account-1", memoryStorage().storage, {
      createNonce: () => `nonce-ordered-${++nonceIndex}`,
      dispatch: async (record) => {
        dispatched.push(record.nonce);
        if (record.nonce === "nonce-ordered-1") return firstAccepted.promise;
        return { message: acceptedMessage("message-ordered-2") };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
    });

    await controller.enqueue(input);
    await controller.enqueue(input);
    expect(controller.getSnapshot()[1]).toMatchObject({
      nonce: "nonce-ordered-2",
      phase: "queued",
      queuedAtMs: null,
    });
    firstAccepted.resolve({ message: acceptedMessage("message-ordered-1") });
    await waitFor(() => controller.getSnapshot()[1]?.phase === "accepted-awaiting-echo");
    expect(dispatched).toEqual(["nonce-ordered-1", "nonce-ordered-2"]);
  });

  test("restores without waiting for a stalled channel and flushes other channels in parallel", async () => {
    let offline = true;
    let nonceIndex = 0;
    const memory = memoryStorage();
    const writer = createDurableSendController("account-1", memory.storage, {
      createNonce: () => `nonce-parallel-${++nonceIndex}`,
      dispatch: async () => ({ message: acceptedMessage("unused") }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "offline",
      isTransportDown: () => offline,
    });
    await writer.enqueue(input);
    await writer.enqueue({
      ...input,
      target: { channelId: "channel-2", conversationId: "conversation-2" },
    });

    offline = false;
    const stalled = deferred<{ message: ChannelMessageView }>();
    const restored = createDurableSendController("account-1", memory.storage, {
      dispatch: (record) =>
        record.target.channelId === "channel-1"
          ? stalled.promise
          : Promise.resolve({
              message: { ...acceptedMessage("message-parallel-2"), channelId: "channel-2" },
            }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
      isTransportDown: () => offline,
    });

    await restored.restore();
    expect(restored.getSnapshot()).toHaveLength(2);
    await waitFor(() =>
      restored
        .getSnapshot()
        .some(
          (record) =>
            record.target.channelId === "channel-2" && record.phase === "accepted-awaiting-echo"
        )
    );
    stalled.resolve({ message: acceptedMessage("message-parallel-1") });
  });

  test("checks prior resend nonces before dispatching a restored replacement", async () => {
    const memory = memoryStorage();
    let offline = true;
    let nonceIndex = 0;
    const writer = createDurableSendController("account-1", memory.storage, {
      now: () => 1_000 + nonceIndex,
      ackTimeoutMs: 1,
      createNonce: () => `nonce-lineage-${++nonceIndex}`,
      dispatch: async () => ({ message: acceptedMessage("message-initial") }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
      isTransportDown: () => offline,
    });
    await writer.enqueue(input);
    const original = writer.getSnapshot()[0];
    expect(original).toBeDefined();
    if (!original) throw new Error("missing original delivery");
    const journal = memory.read() as DurableSendJournal;
    const replacement: DurableSendRecord = {
      ...original,
      nonce: "nonce-lineage-fresh",
      priorNonces: [original.nonce],
      phase: "queued",
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    };
    await memory.storage.write({ ...journal, records: [replacement] });

    offline = false;
    let dispatchCount = 0;
    const restored = createDurableSendController("account-1", memory.storage, {
      dispatch: async () => {
        dispatchCount += 1;
        return { message: acceptedMessage("duplicate") };
      },
      resolveAcceptance: async (record) =>
        record.nonce === original.nonce
          ? {
              status: "accepted",
              acceptedAtMs: 2_100,
              message: acceptedMessage("message-late-original"),
            }
          : { status: "not_found" },
      classifyError: () => "ambiguous",
      isTransportDown: () => offline,
    });
    await restored.restore();
    await waitFor(() => restored.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(restored.getSnapshot()[0]?.acceptedMessage?.id).toBe("message-late-original");
    expect(dispatchCount).toBe(0);
  });

  test("defers an acknowledgement deadline reached while transport is down", async () => {
    let clock = 1_000;
    let offline = false;
    const controller = createDurableSendController("account-1", memoryStorage().storage, {
      now: () => clock,
      ackTimeoutMs: 100,
      createNonce: () => "nonce-deferred-deadline",
      dispatch: async () => ({ message: acceptedMessage("message-deferred") }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
      isTransportDown: () => offline,
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    clock += 101;
    offline = true;
    await controller.expireAcknowledgements();
    expect(controller.getSnapshot()[0]).toMatchObject({
      phase: "accepted-awaiting-echo",
      dispatchStartedAtMs: clock,
    });
    offline = false;
    clock += 50;
    await controller.expireAcknowledgements();
    expect(controller.getSnapshot()[0]?.phase).toBe("accepted-awaiting-echo");
  });

  test("rejects a journal when only part of it is valid", () => {
    const valid = memoryStorage();
    const record = {
      nonce: "nonce-valid-mixed",
      priorNonces: [],
      promptDigest: durableSendPromptDigest(input.payload),
      target: input.target,
      payload: input.payload,
      phase: "queued",
      createdAtMs: 1,
      updatedAtMs: 1,
      attemptCount: 0,
      dispatchStartedAtMs: null,
      queuedAtMs: 1,
      acceptedAtMs: null,
      acceptedMessage: null,
      failedAtMs: null,
      failure: null,
    } satisfies DurableSendRecord;
    expect(
      parseDurableSendJournal({ schemaVersion: 1, scope: "mine", records: [record, {}] }, "mine")
        .records
    ).toEqual([]);
    expect(valid.writes).toEqual([]);
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
        return { message: acceptedMessage("message-staged") };
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

  test("parks a staged attachment when its first commit discovers transport loss", async () => {
    const controller = createDurableSendController("account-1", memoryStorage().storage, {
      now: () => 4_000,
      createNonce: () => "nonce-stage-offline",
      commitStagedAttachments: async () => {
        throw Object.assign(new Error("offline"), { status: 0 });
      },
      dispatch: async () => ({ message: acceptedMessage("unused") }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "offline",
    });

    await controller.enqueue({
      ...input,
      payload: {
        ...input.payload,
        stagedAttachments: [
          {
            stagingId: "stage-offline-1",
            fileName: "offline.txt",
            mimeType: "text/plain",
            byteSize: 12,
            kind: "text",
          },
        ],
      },
    });
    await waitFor(() => controller.getSnapshot()[0]?.phase === "queued");
    expect(controller.getSnapshot()[0]?.queuedAtMs).toBe(4_000);
  });
});
