import { describe, expect, test } from "bun:test";
import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "@openteam/contracts";
import {
  createChannelHistoryStore,
  MESSAGE_HISTORY_MAX_MESSAGES,
  MESSAGE_HISTORY_MAX_RETAINED_BYTES,
  retainedMessageWindowStats,
} from "../src/channel-history";

const message = (sequence: number, content = `Message ${sequence}`): ChannelMessageView => ({
  id: `m-${sequence}`,
  sequence: String(sequence),
  channelId: "channel",
  sender: "agent",
  senderBotId: "bot",
  sourceRunId: null,
  metadata: {},
  content,
  createdAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
});
const messages = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => message(start + index));
const page = (start: number, count = 100): ChannelHistoryPage => ({
  channelId: "channel",
  messages: messages(start, count),
  threadContext: [],
  threadContextTruncated: false,
  beforeSequence: String(start),
  hasMore: start > 1,
  revision: "2000",
});
const context = (
  start: number,
  count: number,
  target: number,
  end = 2000
): ChannelMessageContextView => ({
  ...page(start, count),
  beforeSequence: String(start),
  targetMessageId: `m-${target}`,
  afterSequence: String(start + count - 1),
  hasMoreBefore: start > 1,
  hasMoreAfter: start + count - 1 < end,
});
const assertBudget = (store: ReturnType<typeof createChannelHistoryStore>) => {
  const current = store.get("channel")!;
  const stats = retainedMessageWindowStats(current.history, current.window);
  expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
  expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  expect(store.retained("channel")).toHaveLength(stats.messages);
};

describe("shared history store used by iOS", () => {
  test("traverses deep history in both directions without unbounded retention or inaccessible newer rows", () => {
    const store = createChannelHistoryStore();
    store.acceptPage(page(1901), "replace");
    for (let start = 1801; start >= 1; start -= 100) {
      const anchors = store
        .visible("channel")!
        .slice(0, 5)
        .map((message) => message.id);
      store.setViewport("channel", anchors, false);
      store.acceptPage(page(start), "older");
      expect(store.visible("channel")![0]!.sequence).toBe(String(start));
      for (const anchor of anchors)
        expect(store.visible("channel")!.some((message) => message.id === anchor)).toBe(true);
      assertBudget(store);
    }
    expect(store.status("channel")).toMatchObject({ hasMore: false, hasNewer: true });
    for (let attempts = 0; store.status("channel")!.hasNewer && attempts < 25; attempts += 1) {
      const before = store.visible("channel")!;
      const edge = Number(before.at(-1)!.sequence);
      store.setViewport(
        "channel",
        before.slice(-5).map((message) => message.id),
        false
      );
      store.expand(context(edge + 1, Math.min(100, 2000 - edge), edge), "newer");
      expect(Number(store.visible("channel")!.at(-1)!.sequence)).toBeGreaterThan(edge);
      assertBudget(store);
    }
    expect(store.visible("channel")!.at(-1)!.id).toBe("m-2000");
    expect(store.status("channel")!.hasNewer).toBe(false);
  });

  test("live refresh preserves a scrolled window and the existing jump-to-latest action restores the tail", () => {
    const store = createChannelHistoryStore();
    store.acceptPage(page(1901), "replace");
    store.setViewport("channel", ["m-1901"], false);
    store.acceptContext(context(50, 81, 90));
    const visible = store.visible("channel")!.map((message) => message.id);
    store.acceptPage({ ...page(2001), revision: "2100" }, "refresh");
    expect(store.visible("channel")!.map((message) => message.id)).toEqual(visible);
    assertBudget(store);
    expect(store.jumpToLatest("channel")).toBe(true);
    expect(store.visible("channel")!.at(-1)!.id).toBe("m-2100");
    expect(store.status("channel")!.hasNewer).toBe(false);
  });

  test("resumes live appends after paging forward to the latest edge", () => {
    const store = createChannelHistoryStore();
    store.acceptPage(page(1901), "replace");
    store.acceptContext(context(1800, 100, 1850));
    store.expand(context(1900, 101, 1899), "newer");
    expect(store.status("channel")!.hasNewer).toBe(false);
    store.setViewport("channel", ["m-2000"], true);
    store.acceptPage({ ...page(1902), revision: "2001" }, "refresh");
    expect(store.visible("channel")!.at(-1)!.id).toBe("m-2001");
    assertBudget(store);
  });

  test("bounds large rows by bytes, retains reply ancestors, and patches cached lanes", () => {
    const store = createChannelHistoryStore();
    const large = page(101);
    large.messages = large.messages.map((item) => ({ ...item, content: "x".repeat(40_000) }));
    large.messages[99] = { ...large.messages[99]!, metadata: { replyTo: "m-1", branched: true } };
    large.threadContext = [message(1)];
    store.acceptPage(large, "replace");
    assertBudget(store);
    expect(store.visible("channel")!.some(({ id }) => id === "m-1")).toBe(true);
    const patched = {
      ...message(200),
      content: "updated reaction",
      metadata: { reactions: [{ emoji: "👍", by: "me" }] },
    };
    store.patch(patched);
    expect(store.retained("channel")!.find(({ id }) => id === "m-200")).toEqual(patched);
    store.delete("channel");
    expect(store.get("channel")).toBeUndefined();
    expect(store.visible("channel")).toBeNull();
  });
});
