import { describe, expect, test } from "bun:test";
import type { AssetRef, MarkChannelReadView } from "@openteam/contracts";
import {
  classifyDurableSendError,
  createDurableSendController,
  DURABLE_SEND_SCHEMA_VERSION,
  type DurableSendJournal,
  type DurableSendRecord,
  durableSendIsInFlight,
  durableSendPromptDigest,
  durableSendVisualState,
  type MessageDeliveryAcceptance,
  messageDeliveryAcceptance,
  parseDurableSendJournal,
} from "../src/durable-delivery";
import { projectOutgoingMessages } from "../src/outgoing-messages";
import { createReadReceiptController } from "../src/read-receipts";
import { view } from "./fixtures";

const accepted = (id: string, overrides = {}) => view({ id, metadata: { type: "text" }, ...overrides });
const input = { target: { channelId: "chat", conversationId: "conversation-1" }, payload: { content: "hello", attachments: [] } };
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
};
const memoryStorage = () => {
  let value: unknown = null;
  const writes: DurableSendJournal[] = [];
  return {
    storage: {
      read: async () => value,
      write: async (journal: DurableSendJournal) => { value = structuredClone(journal); writes.push(structuredClone(journal)); },
    },
    writes,
  };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
        return { message: accepted("message-1") };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "fatal",
    });
    expect((await controller.enqueue(input)).nonce).toBe("nonce-accepted-1");
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(dispatches).toHaveLength(1);
    expect(controller.getSnapshot()[0]?.acceptedMessage?.id).toBe("message-1");
    expect(durableSendVisualState(controller.getSnapshot()[0]!)).toBe("accepted");
    await controller.reconcile([accepted("message-1")]);
    expect(controller.getSnapshot()).toEqual([]);
    expect(memory.writes.at(-1)?.records).toEqual([]);
  });

  test("restores an offline queue and checks acceptance before retrying", async () => {
    let offline = true;
    let dispatchCount = 0;
    const memory = memoryStorage();
    const first = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-offline-1",
      dispatch: async () => { dispatchCount += 1; return { message: accepted("message-offline") }; },
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
        return { message: accepted("message-offline") };
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
    const controller = createDurableSendController("account-1", memoryStorage().storage, {
      now: () => clock,
      ackTimeoutMs: 100,
      createNonce: () => `nonce-retry-${++nonceIndex}`,
      dispatch: async (record) => ({ message: accepted(`message-${record.nonce}`) }),
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "ambiguous",
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(durableSendIsInFlight(controller.getSnapshot()[0]!)).toBe(false);
    clock += 101;
    await controller.expireAcknowledgements();
    await waitFor(() => controller.getSnapshot()[0]?.phase === "failed");
    const failed = controller.getSnapshot()[0]!;
    expect(failed.failure?.code).toBe("ack_expired");
    const resent = await controller.resendFailed(failed.nonce);
    expect(resent?.nonce).not.toBe(failed.nonce);
    expect(resent?.priorNonces).toContain(failed.nonce);
  });

  test("server acceptance wins at the retry deadline and no extra submission is made", async () => {
    let clock = 1_000, posts = 0, onServer = false;
    const controller = createDurableSendController("deadline-acceptance", memoryStorage().storage, {
      now: () => clock, retryTimeoutMs: 10_000, createNonce: () => "accepted-on-server",
      classifyError: () => "ambiguous",
      resolveAcceptance: async () => onServer ? { status: "accepted", message: accepted("accepted-late"), acceptedAtMs: clock } : { status: "not_found" },
      dispatch: async () => { posts++; throw Error("Response lost"); },
    });
    await controller.enqueue(input);
    await waitFor(() => controller.getSnapshot()[0]?.phase === "queued");
    clock = 11_001; onServer = true;
    await controller.expireAcknowledgements();
    expect(controller.getSnapshot()[0]?.phase).toBe("accepted-awaiting-echo");
    expect(posts).toBe(1);
    controller.dispose();
  });

  test("fails closed on a corrupt or cross-account journal", () => {
    expect(parseDurableSendJournal({ schemaVersion: 1, scope: "other", records: [] }, "mine")).toEqual({ schemaVersion: DURABLE_SEND_SCHEMA_VERSION, scope: "mine", records: [] });
    expect(parseDurableSendJournal({ schemaVersion: 1, scope: "mine", records: [{}] }, "mine").records).toEqual([]);
  });

  test("durably commits staged attachments before dispatch and then discards local bytes", async () => {
    const memory = memoryStorage();
    const committed: AssetRef = { assetId: "a".repeat(64), fileName: "offline.png", mimeType: "image/png", byteSize: 128, kind: "image" };
    const alreadyUploaded: AssetRef = { assetId: "b".repeat(64), fileName: "already.txt", mimeType: "text/plain", byteSize: 32, kind: "text" };
    const discarded: string[] = [];
    const controller = createDurableSendController("account-1", memory.storage, {
      createNonce: () => "nonce-staged-1",
      commitStagedAttachments: async (record) => {
        expect(record.payload.stagedAttachments?.[0]?.stagingId).toBe("stage-file-1");
        return [committed];
      },
      discardStagedAttachments: async (attachments) => { discarded.push(...attachments.map(({ stagingId }) => stagingId)); },
      dispatch: async (record) => {
        expect(record.payload.stagedAttachments).toEqual([]);
        expect(record.payload.attachments).toEqual([committed, alreadyUploaded]);
        expect(memory.writes.at(-1)?.records[0]?.payload.attachments).toEqual([committed, alreadyUploaded]);
        return { message: accepted("message-staged", { metadata: { type: "text", attachments: [committed, alreadyUploaded] } }) };
      },
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "fatal",
    });
    await controller.enqueue({ ...input, payload: { ...input.payload, attachments: [alreadyUploaded], stagedAttachments: [{
      stagingId: "stage-file-1", fileName: "offline.png", mimeType: "image/png", byteSize: 128, kind: "image", position: 0, previewUri: "file:///durable/stage-file-1",
    }] } });
    await waitFor(() => controller.getSnapshot()[0]?.phase === "accepted-awaiting-echo");
    expect(discarded).toEqual(["stage-file-1"]);
  });

  test("shares durable transport classification and delivery-status mapping", () => {
    expect(classifyDurableSendError({ code: "offline", status: 0 })).toBe("offline");
    expect(classifyDurableSendError({ status: 503 })).toBe("ambiguous");
    expect(classifyDurableSendError({ status: 400 })).toBe("fatal");
    expect(classifyDurableSendError(new Error("connection lost"))).toBe("ambiguous");
    const message = view({ clientId: "client-1" });
    expect(messageDeliveryAcceptance({ clientId: "client-1", status: "accepted", acceptedAtMs: null, message }))
      .toEqual({ status: "accepted", acceptedAtMs: Date.parse(message.createdAt), message });
    expect(messageDeliveryAcceptance({ clientId: "client-2", status: "accepted", acceptedAtMs: null, message: null })).toEqual({ status: "unknown_durability" });
  });
});

describe("shared outgoing message projection", () => {
  const record = (extra: Partial<DurableSendRecord> = {}): DurableSendRecord => {
    const target = { channelId: "chat", conversationId: null };
    const payload = { content: "hello", attachments: [] };
    return {
      nonce: "nonce", lineageId: "nonce", priorNonces: [], target, payload, promptDigest: durableSendPromptDigest(payload, target), phase: "queued",
      createdAtMs: Date.parse("2026-09-01T12:00:00.000Z"), updatedAtMs: 1, attemptCount: 0, dispatchStartedAtMs: null, queuedAtMs: 1,
      acceptedAtMs: null, acceptedMessage: null, failedAtMs: null, failure: null, ...extra,
    };
  };

  test("a lost response or old resend nonce produces one acknowledged row", () => {
    const delivery = record({ nonce: "replacement", priorNonces: ["original"] });
    const echo = accepted("server", { clientId: "original", createdAt: "2026-09-01T12:00:00.000Z" });
    const desktop = projectOutgoingMessages([echo], [delivery]);
    const mobile = projectOutgoingMessages([echo], [delivery], { echoRenderKey: "delivery", orderBy: "messageId" });
    expect([desktop.length, mobile.length]).toEqual([1, 1]);
    expect(desktop[0]!.message).toBe(echo);
    expect([desktop[0]!.renderKey, mobile[0]!.renderKey]).toEqual(["optimistic:original", "optimistic:replacement"]);
    expect(desktop[0]).toMatchObject({ pending: false, delivery: { phase: "accepted-awaiting-echo", acceptedAtMs: Date.parse(echo.createdAt) } });
    expect(delivery.phase).toBe("queued");
  });

  test("does not mistake a different-channel echo for the send", () => {
    expect(projectOutgoingMessages([accepted("other", { channelId: "other-chat", clientId: "nonce" })], [record()])).toHaveLength(2);
  });
});

describe("shared desktop/native read receipts", () => {
  const receipt = (sequence: string): MarkChannelReadView => ({ channelId: "chat", lastReadSequence: sequence, unreadCount: 0 });

  test("serializes each channel and coalesces to the highest pending sequence", async () => {
    const controller = createReadReceiptController();
    const first = deferred<MarkChannelReadView>();
    const sends: Array<string | undefined> = [];
    const acknowledgements: string[] = [];
    const options = {
      send: async (_id: string, through?: string) => { sends.push(through); return sends.length === 1 ? first.promise : receipt(through!); },
      onAcknowledged: (value: MarkChannelReadView) => { acknowledgements.push(value.lastReadSequence); },
    };
    const request = controller.request("chat", "10", options);
    await Promise.resolve();
    controller.request("chat", "20", options);
    controller.request("chat", "15", options);
    expect(sends).toEqual(["10"]);
    first.resolve(receipt("10"));
    await request;
    expect(sends).toEqual(["10", "20"]);
    expect(acknowledgements).toEqual(["10", "20"]);
    await controller.request("chat", "19", options);
    expect(sends).toHaveLength(2);
  });

  test("discarded account leases cannot publish results or clear a newer request", async () => {
    const controller = createReadReceiptController();
    const old = deferred<MarkChannelReadView>();
    const published: string[] = [];
    const previous = controller.request("chat", "100", { send: () => old.promise, onAcknowledged: () => { published.push("old"); } });
    await Promise.resolve();
    controller.clear();
    await controller.request("chat", "1", { send: async () => receipt("1"), onAcknowledged: () => { published.push("new"); } });
    old.resolve(receipt("100"));
    await previous;
    expect(published).toEqual(["new"]);
    expect(controller.acknowledgedThrough("chat")).toBe("1");
  });
});
