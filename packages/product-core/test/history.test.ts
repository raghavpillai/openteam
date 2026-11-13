import { describe, expect, test } from "bun:test";
import type { ChannelMessageContextView } from "@openteam/contracts";
import { createChannelHistoryStore, MESSAGE_HISTORY_MAX_MESSAGES, MESSAGE_HISTORY_MAX_RETAINED_BYTES, retainedMessageWindowStats } from "../src/channel-history";
import { boundMessageWindow, latestRefreshOverlap, messageRetainedByteSize } from "../src/message-window";
import { numbered, page, range } from "./fixtures";

const context = (start: number, count: number, target: number, end = 2000): ChannelMessageContextView => ({
  ...page(start, count), beforeSequence: String(start), targetMessageId: `message-${target}`, afterSequence: String(start + count - 1),
  hasMoreBefore: start > 1, hasMoreAfter: start + count - 1 < end,
});
const assertBudget = (store: ReturnType<typeof createChannelHistoryStore>) => {
  const current = store.get("chat")!;
  const stats = retainedMessageWindowStats(current.history, current.window);
  expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
  expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  expect(store.retained("chat")).toHaveLength(stats.messages);
};

describe("shared history store used by iOS", () => {
  test("traverses deep history in both directions without unbounded retention or inaccessible newer rows", () => {
    const store = createChannelHistoryStore();
    store.acceptPage(page(1901), "replace");
    for (let start = 1801; start >= 1; start -= 100) {
      const anchors = store.visible("chat")!.slice(0, 5).map((message) => message.id);
      store.setViewport("chat", anchors, false);
      store.acceptPage(page(start), "older");
      expect(store.visible("chat")![0]!.sequence).toBe(String(start));
      for (const anchor of anchors) expect(store.visible("chat")!.some((message) => message.id === anchor)).toBe(true);
      assertBudget(store);
    }
    expect(store.status("chat")).toMatchObject({ hasMore: false, hasNewer: true });
    for (let attempts = 0; store.status("chat")!.hasNewer && attempts < 25; attempts += 1) {
      const before = store.visible("chat")!;
      const edge = Number(before.at(-1)!.sequence);
      store.setViewport("chat", before.slice(-5).map((message) => message.id), false);
      store.expand(context(edge + 1, Math.min(100, 2000 - edge), edge), "newer");
      expect(Number(store.visible("chat")!.at(-1)!.sequence)).toBeGreaterThan(edge);
      assertBudget(store);
    }
    expect(store.visible("chat")!.at(-1)!.id).toBe("message-2000");
    expect(store.status("chat")!.hasNewer).toBe(false);
  });

  test("bounds large rows by bytes, retains reply ancestors, and patches cached lanes", () => {
    const store = createChannelHistoryStore();
    const large = page(101);
    large.messages = large.messages.map((item) => ({ ...item, content: "x".repeat(40_000) }));
    large.messages[99] = { ...large.messages[99]!, metadata: { replyTo: "message-1", branched: true } };
    large.threadContext = [numbered(1)];
    store.acceptPage(large, "replace");
    assertBudget(store);
    expect(store.visible("chat")!.some(({ id }) => id === "message-1")).toBe(true);
    const patched = { ...numbered(200), content: "updated reaction", metadata: { reactions: [{ emoji: "👍", by: "me" }] } };
    store.patch(patched);
    expect(store.retained("chat")!.find(({ id }) => id === "message-200")).toEqual(patched);
    store.delete("chat");
    expect(store.get("chat")).toBeUndefined();
    expect(store.visible("chat")).toBeNull();
  });

  test("read caches are invalidated by every state transition and released on eviction", () => {
    const store = createChannelHistoryStore();
    const first = page(1, 2, "2");
    store.acceptPage(first, "replace");
    const visible = store.visible("chat");
    const ids = store.visibleIds("chat");
    const retained = store.retained("chat");
    expect(store.visible("chat")).toBe(visible);
    expect(store.visibleIds("chat")).toBe(ids);
    expect(store.retained("chat")).toBe(retained);
    store.setViewport("chat", ["message-2"], true);
    expect(store.visible("chat")).toBe(visible);
    store.patch(numbered(2, { content: "patched" }));
    expect(store.visible("chat")).not.toBe(visible);
    expect(store.visible("chat")!.at(-1)!.content).toBe("patched");
    store.acceptPage({ ...first, messages: range(1, 3), revision: "3" }, "refresh");
    expect(store.visibleIds("chat")!.has("message-3")).toBe(true);
    store.delete("chat");
    expect([store.visible("chat"), store.visibleIds("chat"), store.retained("chat")]).toEqual([null, null, null]);
    store.acceptPage(first, "replace");
    expect(store.visible("chat")).not.toBe(visible);
    store.clear();
    expect(store.status("chat")).toBeNull();
  });
});

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
