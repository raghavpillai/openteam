import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { createChannelHistoryStore } from "../src/channel-history";
import {
  createDurableSendEchoResolver,
  type DurableSendRecord,
  durableSendAuthoritativeEcho,
  durableSendPromptDigest,
} from "../src/durable-delivery";
import { compareEntitySequence, messageCreatedAtMs, sortedUniqueMessages } from "../src/history";

const message = (
  index: number,
  overrides: Partial<ChannelMessageView> = {}
): ChannelMessageView => ({
  id: `message-${index}`,
  channelId: "chat",
  sequence: String(index),
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: {},
  createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  ...overrides,
});
const record = (overrides: Partial<DurableSendRecord> = {}): DurableSendRecord => {
  const payload = { content: "hello", attachments: [] };
  const target = { channelId: "chat", conversationId: null };
  return {
    nonce: "nonce",
    lineageId: "nonce",
    priorNonces: [],
    target,
    payload,
    promptDigest: durableSendPromptDigest(payload, target),
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
    ...overrides,
  };
};

describe("performance optimizations preserve product semantics", () => {
  test("cached chronology preserves timezone offsets, invalid dates, ties, and mutable callers", () => {
    const left = message(1, { createdAt: "2026-09-03T13:00:00+02:00" });
    const right = message(2, { createdAt: "2026-09-03T12:00:00Z" });
    expect(sortedUniqueMessages([right, left])).toEqual([left, right]);
    expect(messageCreatedAtMs(left)).toBe(Date.parse(left.createdAt));
    left.createdAt = "2026-09-04T00:00:00Z";
    expect(sortedUniqueMessages([right, left])).toEqual([right, left]);
    left.createdAt = "invalid";
    expect(Number.isNaN(messageCreatedAtMs(left))).toBe(true);
    const tie = message(3, { createdAt: right.createdAt });
    expect(sortedUniqueMessages([tie, right])).toEqual([right, tie]);
  });
  test("cached numeric sequences retain bigint precision and invalidate on source changes", () => {
    const left = { sequence: "9007199254740993" };
    const right = { sequence: "9007199254740994" };
    expect(compareEntitySequence(left, right)).toBe(-1);
    left.sequence = "9007199254740995";
    expect(compareEntitySequence(left, right)).toBe(1);
    left.sequence = "local";
    expect(compareEntitySequence(left, right)).toBe(left.sequence.localeCompare(right.sequence));
  });
  test("batch echo indexing matches the original resolver across nonce lineage and duplicates", () => {
    const cases = [
      [message(1, { clientId: "old" }), message(2, { clientId: "nonce" })],
      [message(1, { clientId: "nonce", content: "mismatch" }), message(2, { clientId: "nonce" })],
      [
        message(1, { clientId: "nonce", channelId: "different" }),
        message(2, { clientId: "nonce" }),
      ],
      [message(1), message(1, { content: "duplicate id with different payload" })],
      [],
    ];
    for (const candidates of cases) {
      const messages = [
        ...candidates,
        ...Array.from({ length: 50 }, (_, i) => message(i + 100, { channelId: "unrelated" })),
      ];
      const resolve = createDurableSendEchoResolver(messages, 100);
      for (const value of [
        record(),
        record({ priorNonces: ["old"] }),
        record({ acceptedMessage: message(1) }),
        record({ nonce: "missing" }),
      ]) {
        expect(resolve(value)).toBe(durableSendAuthoritativeEcho(value, messages));
      }
    }
  });
  test("history read caches are invalidated by every state transition and released on eviction", () => {
    const store = createChannelHistoryStore();
    const page = {
      channelId: "chat",
      messages: [message(1), message(2)],
      threadContext: [],
      threadContextTruncated: false,
      beforeSequence: "1",
      hasMore: false,
      revision: "2",
    };
    store.acceptPage(page, "replace");
    const visible = store.visible("chat");
    const ids = store.visibleIds("chat");
    const retained = store.retained("chat");
    expect(store.visible("chat")).toBe(visible);
    expect(store.visibleIds("chat")).toBe(ids);
    expect(store.retained("chat")).toBe(retained);
    store.setViewport("chat", ["message-2"], true);
    expect(store.visible("chat")).toBe(visible);
    store.patch(message(2, { content: "patched" }));
    expect(store.visible("chat")).not.toBe(visible);
    expect(store.visible("chat")!.at(-1)!.content).toBe("patched");
    store.acceptPage(
      { ...page, messages: [...page.messages, message(3)], revision: "3" },
      "refresh"
    );
    expect(store.visibleIds("chat")!.has("message-3")).toBe(true);
    store.delete("chat");
    expect(store.visible("chat")).toBeNull();
    expect(store.visibleIds("chat")).toBeNull();
    expect(store.retained("chat")).toBeNull();
    store.acceptPage(page, "replace");
    expect(store.visible("chat")).not.toBe(visible);
    store.clear();
    expect(store.status("chat")).toBeNull();
  });
});
