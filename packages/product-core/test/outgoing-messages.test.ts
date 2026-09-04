import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { type DurableSendRecord, durableSendPromptDigest } from "../src/durable-delivery";
import { projectOutgoingMessages } from "../src/outgoing-messages";

const message = (id: string, extra: Partial<ChannelMessageView> = {}): ChannelMessageView => ({
  id,
  channelId: "chat",
  sequence: "1",
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: { type: "text" },
  createdAt: "2026-09-01T12:00:00.000Z",
  ...extra,
});
const record = (extra: Partial<DurableSendRecord> = {}): DurableSendRecord => {
  const target = { channelId: "chat", conversationId: null };
  const payload = { content: "hello", attachments: [] };
  return {
    nonce: "nonce",
    lineageId: "nonce",
    priorNonces: [],
    target,
    payload,
    promptDigest: durableSendPromptDigest(payload, target),
    phase: "queued",
    createdAtMs: Date.parse("2026-09-01T12:00:00.000Z"),
    updatedAtMs: 1,
    attemptCount: 0,
    dispatchStartedAtMs: null,
    queuedAtMs: 1,
    acceptedAtMs: null,
    acceptedMessage: null,
    failedAtMs: null,
    failure: null,
    ...extra,
  };
};

describe("shared outgoing message projection", () => {
  test("keeps queued/failed messages and ordinary message references unchanged", () => {
    const ordinary = message("ordinary", { sender: "agent" });
    const queued = record();
    const [local] = projectOutgoingMessages([], [queued]);
    expect(local).toMatchObject({ renderKey: "optimistic:nonce", pending: true, delivery: queued });
    expect(local!.message.content).toBe("hello");
    const failed = record({
      phase: "failed",
      failure: { code: "offline", message: "Failed", uncertain: false },
    });
    expect(projectOutgoingMessages([], [failed])[0]).toMatchObject({
      pending: false,
      delivery: failed,
    });
    expect(projectOutgoingMessages([ordinary], [])[0]!.message).toBe(ordinary);
  });
  test("a lost response or old resend nonce produces one acknowledged row", () => {
    const delivery = record({ nonce: "replacement", priorNonces: ["original"] });
    const echo = message("server", { clientId: "original" });
    const desktop = projectOutgoingMessages([echo], [delivery]);
    const mobile = projectOutgoingMessages([echo], [delivery], {
      echoRenderKey: "delivery",
      orderBy: "messageId",
    });
    expect(desktop).toHaveLength(1);
    expect(mobile).toHaveLength(1);
    expect(desktop[0]!.message).toBe(echo);
    expect(desktop[0]!.renderKey).toBe("optimistic:original");
    expect(mobile[0]!.renderKey).toBe("optimistic:replacement");
    expect(desktop[0]).toMatchObject({
      pending: false,
      delivery: { phase: "accepted-awaiting-echo", acceptedAtMs: Date.parse(echo.createdAt) },
    });
    expect(delivery.phase).toBe("queued");
  });
  test("prefers a current server message over a stale direct-send response", () => {
    const accepted = message("server", { clientId: "nonce" });
    const fresh = {
      ...accepted,
      metadata: { ...(accepted.metadata as object), reactions: [{ emoji: "👍", by: "me" }] },
    };
    const delivery = record({
      phase: "accepted-awaiting-echo",
      acceptedMessage: accepted,
      acceptedAtMs: 25,
    });
    const projected = projectOutgoingMessages([fresh], [delivery]);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.message).toBe(fresh);
    expect(projected[0]!.delivery!.acceptedAtMs).toBe(25);
  });
  test("does not mistake a different-channel echo for the send", () => {
    const other = message("other", { channelId: "other-chat", clientId: "nonce" });
    expect(projectOutgoingMessages([other], [record()])).toHaveLength(2);
  });
  test("keeps the existing per-renderer ordering for equal timestamps", () => {
    const accepted = message("a-server");
    const ordinary = message("m-server", { sender: "agent" });
    const delivery = record({ acceptedMessage: accepted, phase: "accepted-awaiting-echo" });
    expect(projectOutgoingMessages([ordinary], [delivery]).map((item) => item.message.id)).toEqual([
      "m-server",
      "a-server",
    ]);
    expect(
      projectOutgoingMessages([ordinary], [delivery], {
        orderBy: "messageId",
        echoRenderKey: "delivery",
      }).map((item) => item.message.id)
    ).toEqual(["a-server", "m-server"]);
  });
});
