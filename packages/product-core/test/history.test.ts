import { describe, expect, test } from "bun:test";
import { boundMessageWindow, latestRefreshOverlap, messageRetainedByteSize } from "../src/message-window";
import { numbered, range } from "./fixtures";

describe("bounded message windows", () => {
  const newest = { maxMessages: 500, maxBytes: 100 * 1024 * 1024, retain: "newest" as const };

  test("keeps the newest 500 of 1,000 messages and reports an older gap", () => {
    const result = boundMessageWindow(range(1, 1_000), newest);
    expect(result.messages).toHaveLength(500);
    expect([result.messages[0]?.id, result.messages.at(-1)?.id]).toEqual(["message-501", "message-1000"]);
    expect(result.eviction).toEqual({ older: { count: 500, adjacentEvictedMessageId: "message-500", boundaryRetainedMessageId: "message-501" }, newer: null });
    expect(result.gaps).toEqual({ older: true, newer: false });
  });

  test("uses the total retained byte budget and keeps an indivisible rich message", () => {
    const rich = numbered(3, { content: "rich".repeat(10_000) });
    const result = boundMessageWindow([numbered(1), numbered(2), rich], { ...newest, maxMessages: 10, maxBytes: 1_000 });
    expect(result.messages).toEqual([rich]);
    expect(result.retainedBytes).toBe(messageRetainedByteSize(rich));
    expect(result.softExcess).toMatchObject({ bytes: result.retainedBytes - 1_000, messages: 0, protected: false, oversized: true });
    expect(result.gaps.older).toBe(true);
  });

  test("extends a contiguous window rather than evicting a protected visible anchor", () => {
    const result = boundMessageWindow(range(1, 1_000), { ...newest, protectedIds: new Set(["message-450", "message-999"]) });
    expect(result.messages).toHaveLength(551);
    expect([result.messages[0]?.id, result.messages.at(-1)?.id]).toEqual(["message-450", "message-1000"]);
    expect(result.softExcess).toEqual({ messages: 51, bytes: 0, protected: true, oversized: false });
    expect(result.eviction.older?.count).toBe(449);
  });

  test("moves transitive reply ancestors outside the primary cap into thread context", () => {
    const root = numbered(1);
    const reply = numbered(2, { metadata: { branched: true, replyTo: root.id } });
    const nested = numbered(3, { metadata: { branched: true, replyTo: reply.id } });
    const result = boundMessageWindow([nested], { ...newest, maxMessages: 1, threadContext: [reply, root] });
    expect(result.messages.map(({ id }) => id)).toEqual([nested.id]);
    expect(result.threadContext.map(({ id }) => id)).toEqual([root.id, reply.id]);
    expect(result.retainedBytes).toBe(messageRetainedByteSize(root) + messageRetainedByteSize(reply) + messageRetainedByteSize(nested));
    expect(result.missingAncestorIds).toEqual([]);
  });

  test("latest refreshes merge on shared IDs even with sparse sequences and reset without any", () => {
    expect(latestRefreshOverlap([numbered(1), numbered(10), numbered(100)], [numbered(100), numbered(1_000), numbered(10_000)])).toEqual({
      disposition: "merge", overlaps: true, requiresReset: false, overlapIds: ["message-100"],
      retainedNewestMessageId: "message-100", refreshOldestMessageId: "message-100", refreshNewestMessageId: "message-10000",
    });
    expect(latestRefreshOverlap(range(1, 100), range(151, 100))).toMatchObject({ disposition: "reset", overlaps: false, requiresReset: true, overlapIds: [] });
  });
});
