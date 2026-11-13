import { describe, expect, test } from "bun:test";
import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "@openteam/contracts";
import { emptyLoadedChannelHistory } from "@openteam/product-core/history";
import { messageRetainedByteSize } from "@openteam/product-core/message-window";
import {
  applyPrimaryHistoryPage,
  clearMessageContext,
  emptyChannelMessageWindow,
  enterMessageContext,
  expandMessageContext,
  MESSAGE_HISTORY_MAX_MESSAGES,
  MESSAGE_HISTORY_MAX_RETAINED_BYTES,
  MESSAGE_HISTORY_PAGE_SIZE,
  patchRetainedMessageWindow,
  resetToLatestTail,
  retainedMessageWindowStats,
  setContextLoading,
  visibleChannelHistoryMessages,
} from "../../src/renderer/lib/message-history-window";

const message = (sequence: number, content = `message ${sequence}`): ChannelMessageView => ({
  id: `message-${sequence}`,
  sequence: String(sequence),
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content,
  metadata: {},
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
});

const messages = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => message(start + index));

const retainedBytes = (...lanes: ReadonlyArray<readonly ChannelMessageView[]>): number => {
  const unique = new Map<string, ChannelMessageView>();
  for (const lane of lanes) for (const candidate of lane) unique.set(candidate.id, candidate);
  return [...unique.values()].reduce(
    (total, candidate) => total + messageRetainedByteSize(candidate),
    0
  );
};

const historyPage = (start: number, count: number, hasMore = true): ChannelHistoryPage => ({
  channelId: "channel-1",
  messages: messages(start, count),
  threadContext: [],
  threadContextTruncated: false,
  beforeSequence: String(start),
  hasMore,
  revision: String(start + count),
});

const contextPage = (
  start: number,
  count: number,
  target = start + Math.floor(count / 2),
  hasMoreBefore = true,
  hasMoreAfter = true
): ChannelMessageContextView => ({
  channelId: "channel-1",
  targetMessageId: `message-${target}`,
  messages: messages(start, count),
  threadContext: [],
  threadContextTruncated: false,
  beforeSequence: String(start),
  afterSequence: String(start + count - 1),
  hasMoreBefore,
  hasMoreAfter,
  revision: String(start + count),
});

type Transition = ReturnType<typeof applyPrimaryHistoryPage>;
const load = (
  previous: Pick<Transition, "history" | "window"> | undefined,
  page: ChannelHistoryPage,
  mode: "replace" | "older" | "refresh",
  extra: Partial<Parameters<typeof applyPrimaryHistoryPage>[0]> = {}
) =>
  applyPrimaryHistoryPage({
    current: previous?.history,
    window: previous?.window,
    page,
    mode,
    atBottom: mode === "replace",
    ...extra,
  });

describe("desktop bounded message-history windows", () => {
  test("keeps five pages unchanged, then reserves the cached latest tail and bounds every lane to 500", () => {
    let transition = load(undefined, historyPage(501, 100), "replace");
    for (const start of [401, 301, 201, 101]) transition = load(transition, historyPage(start, 100), "older");
    expect(transition.history.messages).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(transition.history.messages[0]?.id).toBe("message-101");
    expect(transition.history.messages.at(-1)?.id).toBe("message-600");
    expect(transition.window.primaryHasNewerGap).toBe(false);

    transition = load(transition, historyPage(1, 100, false), "older");
    expect(transition.history.messages).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES - MESSAGE_HISTORY_PAGE_SIZE);
    expect(transition.history.messages[0]?.id).toBe("message-1");
    expect(transition.history.messages.at(-1)?.id).toBe("message-400");
    expect(transition.evictedNewer).toBe(200);
    expect(transition.window.primaryHasNewerGap).toBe(true);
    expect(transition.window.latestTail?.messages[0]?.id).toBe("message-501");
    expect(transition.window.latestTail?.messages.at(-1)?.id).toBe("message-600");
    expect(retainedMessageWindowStats(transition.history, transition.window).messages).toBe(MESSAGE_HISTORY_MAX_MESSAGES);

    // A disjoint centered context displaces the primary lane but keeps the cached tail.
    const contextual = enterMessageContext(transition.history, transition.window, contextPage(1_001, 500, 1_250));
    const stats = retainedMessageWindowStats(contextual.history, contextual.window);
    expect(contextual.history.searchContext).toHaveLength(400);
    expect(contextual.window.latestTail?.messages).toHaveLength(100);
    expect(contextual.history.messages).toHaveLength(0);
    expect(stats.messages).toBe(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBe(contextual.window.retainedBytes);
  });

  test("preserves an off-bottom window on a no-overlap reconnect and resets instantly from its tail", () => {
    const refreshed = load(load(undefined, historyPage(1, 100), "replace"), historyPage(151, 100), "refresh");
    expect(refreshed.outcome).toBe("preserved-gap");
    expect(refreshed.history.messages.at(-1)?.id).toBe("message-100");
    expect(refreshed.window.primaryHasNewerGap).toBe(true);

    const reset = resetToLatestTail(refreshed.history, refreshed.window, 3);
    expect(reset?.history.messages[0]?.id).toBe("message-151");
    expect(reset?.history.messages.at(-1)?.id).toBe("message-250");
    expect(reset?.window.primaryHasNewerGap).toBe(false);
    expect(reset?.window.latestTail).toBeNull();
  });

  test("renders one centered context lane and pages both directions with opposite-edge eviction", () => {
    const initial = load(undefined, historyPage(901, 100), "replace");
    let transition = enterMessageContext(initial.history, initial.window, contextPage(451, 101, 501), 2);
    expect(visibleChannelHistoryMessages(transition.history, transition.window)).toHaveLength(101);
    expect(transition.window.context).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    for (const start of [351, 251, 151, 51]) {
      transition = expandMessageContext({ current: transition.history, window: transition.window, page: contextPage(start, 101, start + 100), direction: "older" });
    }
    expect(transition.history.searchContext.length).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(transition.window.context?.hasMoreAfter).toBe(true);

    const newer = expandMessageContext({ current: transition.history, window: transition.window, page: contextPage(500, 101, 500), direction: "newer" });
    expect(newer.evictedOlder).toBeGreaterThan(0);
    expect(newer.window.context).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    expect(new Set(newer.history.searchContext.map(({ id }) => id)).size).toBe(newer.history.searchContext.length);
  });

  test("keeps an explicit newer gap when latest messages arrive while context is open", () => {
    const initial = load(undefined, historyPage(901, 100), "replace");
    const contextual = enterMessageContext(initial.history, initial.window, contextPage(451, 101, 501));
    const unchanged = load(contextual, historyPage(901, 100), "refresh");
    expect(unchanged.window.primaryHasNewerGap).toBe(false);

    const refreshed = load(unchanged, historyPage(902, 100), "refresh");
    expect(refreshed.window.primaryHasNewerGap).toBe(true);
    expect(refreshed.window.latestTail?.messages.at(-1)?.id).toBe("message-1001");

    const cleared = clearMessageContext(refreshed.history, refreshed.window);
    expect(cleared.history.messages.at(-1)?.id).toBe("message-1000");
    expect(cleared.window.primaryHasNewerGap).toBe(true);
  });

  test("advances older pagination when a stale viewport would discard the requested page", () => {
    const viewport = (ids: ChannelMessageView[]) => ({
      viewport: { fill: "older-first" as const, messageIds: new Set(ids.map(({ id }) => id)) },
    });
    let transition = load(undefined, historyPage(1_001, 100), "replace");
    for (const start of [901, 801, 701, 601, 501]) {
      transition = load(transition, historyPage(start, 100), "older", viewport(transition.history.messages.slice(0, 10)));
    }
    expect(transition.history.beforeSequence).toBe("501");
    expect(transition.history.messages).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES - MESSAGE_HISTORY_PAGE_SIZE);
    expect(transition.window.latestTail?.messages).toHaveLength(MESSAGE_HISTORY_PAGE_SIZE);

    const older = load(transition, historyPage(401, 100), "older", viewport(transition.history.messages.slice(-10)));
    const stats = retainedMessageWindowStats(older.history, older.window);
    expect(older.history.beforeSequence).toBe("401");
    expect(older.history.messages[0]?.id).toBe("message-401");
    expect(older.history.messages.at(-1)?.id).toBe("message-800");
    expect(older.evictedOlder).toBe(0);
    expect(older.evictedNewer).toBe(100);
    expect(older.window.primaryHasNewerGap).toBe(true);
    expect(older.window.latestTail?.messages[0]?.id).toBe("message-1001");
    expect(stats.messages).toBe(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("patches every retained copy, recomputes exact bytes, and invalidates context loading", () => {
    const root = message(1);
    const reply = { ...message(1_000), metadata: { replyTo: root.id } };
    const entered = enterMessageContext(
      { ...emptyLoadedChannelHistory(), messages: [root], loadedAt: 1 },
      emptyChannelMessageWindow(),
      { ...contextPage(1, 1, 1, false, false), messages: [root] }
    );
    const latestTail = {
      messages: [reply],
      threadContext: [root],
      threadContextTruncated: false,
      beforeSequence: reply.sequence,
      hasMore: true,
      revision: "1",
      retainedBytes: retainedBytes([reply], [root]),
    };
    const { history } = entered;
    const loadingWindow = setContextLoading(
      { ...entered.window, latestTail, retainedBytes: retainedBytes(history.messages, history.threadContext, history.searchContext, history.searchThreadContext, [reply], [root]) },
      "newer"
    );
    const updated = { ...root, content: "updated root with reaction metadata", metadata: { reactions: [] } };
    const patched = patchRetainedMessageWindow(history, loadingWindow, updated);
    if (!patched) throw new Error("expected patched retained state");

    expect(patched.window.generation).toBe(loadingWindow.generation + 1);
    expect(patched.window.context?.loadingDirection).toBeNull();
    expect(patched.history.messages.find(({ id }) => id === root.id)).toBe(updated);
    expect(patched.history.searchContext.find(({ id }) => id === root.id)).toBe(updated);
    expect(patched.window.latestTail?.threadContext.find(({ id }) => id === root.id)).toBe(updated);
    expect(retainedMessageWindowStats(patched.history, patched.window).bytes).toBe(patched.window.retainedBytes);
    const reset = resetToLatestTail(patched.history, patched.window);
    expect(reset?.history.threadContext.find(({ id }) => id === root.id)).toBe(updated);
  });
});
