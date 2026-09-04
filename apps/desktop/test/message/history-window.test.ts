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

describe("desktop bounded message-history windows", () => {
  test("keeps normal history unchanged through five pages, then reserves the cached latest tail", () => {
    let history = emptyLoadedChannelHistory();
    let window = emptyChannelMessageWindow();
    let transition = applyPrimaryHistoryPage({
      current: history,
      window,
      page: historyPage(501, 100),
      mode: "replace",
      atBottom: true,
      loadedAt: 1,
    });
    history = transition.history;
    window = transition.window;
    for (const start of [401, 301, 201, 101]) {
      transition = applyPrimaryHistoryPage({
        current: history,
        window,
        page: historyPage(start, 100),
        mode: "older",
        atBottom: false,
        loadedAt: start,
      });
      history = transition.history;
      window = transition.window;
    }
    expect(history.messages).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(history.messages[0]?.id).toBe("message-101");
    expect(history.messages.at(-1)?.id).toBe("message-600");
    expect(window.primaryHasNewerGap).toBe(false);

    transition = applyPrimaryHistoryPage({
      current: history,
      window,
      page: historyPage(1, 100, false),
      mode: "older",
      atBottom: false,
      loadedAt: 2,
    });
    expect(transition.history.messages).toHaveLength(
      MESSAGE_HISTORY_MAX_MESSAGES - MESSAGE_HISTORY_PAGE_SIZE
    );
    expect(transition.history.messages[0]?.id).toBe("message-1");
    expect(transition.history.messages.at(-1)?.id).toBe("message-400");
    expect(transition.evictedNewer).toBe(200);
    expect(transition.window.primaryHasNewerGap).toBe(true);
    expect(transition.window.latestTail?.messages[0]?.id).toBe("message-501");
    expect(transition.window.latestTail?.messages.at(-1)?.id).toBe("message-600");
    expect(retainedMessageWindowStats(transition.history, transition.window).messages).toBe(
      MESSAGE_HISTORY_MAX_MESSAGES
    );
  });

  test("preserves an off-bottom window on a no-overlap reconnect and resets instantly from its tail", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(1, 100),
      mode: "replace",
      atBottom: true,
      loadedAt: 1,
    });
    const refreshed = applyPrimaryHistoryPage({
      current: initial.history,
      window: initial.window,
      page: historyPage(151, 100),
      mode: "refresh",
      atBottom: false,
      loadedAt: 2,
    });
    expect(refreshed.outcome).toBe("preserved-gap");
    expect(refreshed.history.messages.at(-1)?.id).toBe("message-100");
    expect(refreshed.window.primaryHasNewerGap).toBe(true);

    const reset = resetToLatestTail(refreshed.history, refreshed.window, 3);
    expect(reset?.history.messages[0]?.id).toBe("message-151");
    expect(reset?.history.messages.at(-1)?.id).toBe("message-250");
    expect(reset?.window.primaryHasNewerGap).toBe(false);
    expect(reset?.window.latestTail).toBeNull();
  });

  test("resets a no-overlap refresh automatically when the viewport follows the bottom", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(1, 100),
      mode: "replace",
      atBottom: true,
    });
    const refreshed = applyPrimaryHistoryPage({
      current: initial.history,
      window: initial.window,
      page: historyPage(151, 100),
      mode: "refresh",
      atBottom: true,
    });
    expect(refreshed.outcome).toBe("applied");
    expect(refreshed.history.messages[0]?.id).toBe("message-151");
    expect(refreshed.window.primaryHasNewerGap).toBe(false);
  });

  test("renders one centered context lane and pages both directions with opposite-edge eviction", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(901, 100),
      mode: "replace",
      atBottom: true,
    });
    let transition = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(451, 101, 501),
      2
    );
    expect(visibleChannelHistoryMessages(transition.history, transition.window)).toHaveLength(101);
    expect(transition.window.context).toMatchObject({
      hasMoreBefore: true,
      hasMoreAfter: true,
    });

    for (const start of [351, 251, 151, 51]) {
      transition = expandMessageContext({
        current: transition.history,
        window: transition.window,
        page: contextPage(start, 101, start + 100),
        direction: "older",
      });
    }
    expect(transition.history.searchContext.length).toBeLessThanOrEqual(
      MESSAGE_HISTORY_MAX_MESSAGES
    );
    expect(transition.window.context?.hasMoreAfter).toBe(true);

    const newer = expandMessageContext({
      current: transition.history,
      window: transition.window,
      page: contextPage(500, 101, 500, true, true),
      direction: "newer",
    });
    expect(newer.evictedOlder).toBeGreaterThan(0);
    expect(newer.window.context?.hasMoreBefore).toBe(true);
    expect(newer.window.context?.hasMoreAfter).toBe(true);
    expect(new Set(newer.history.searchContext.map(({ id }) => id)).size).toBe(
      newer.history.searchContext.length
    );
  });

  test("updates the context anchor metadata when bounded paging evicts the original target", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(2_001, 100),
      mode: "replace",
      atBottom: true,
    });
    let transition = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(1_001, 101, 1_051)
    );
    for (const start of [901, 801, 701, 601, 501]) {
      transition = expandMessageContext({
        current: transition.history,
        window: transition.window,
        page: contextPage(start, 101, start + 100),
        direction: "older",
      });
    }

    expect(transition.history.searchContext).toHaveLength(
      MESSAGE_HISTORY_MAX_MESSAGES - MESSAGE_HISTORY_PAGE_SIZE
    );
    expect(
      transition.history.searchContext.some((candidate) => candidate.id === "message-1051")
    ).toBe(false);
    expect(
      transition.history.searchContext.some(
        (candidate) => candidate.id === transition.window.context?.targetMessageId
      )
    ).toBe(true);
    expect(transition.window.context?.targetMessageId).toBe("message-900");
  });

  test("advances context pagination in both directions when a stale viewport favors the old lane", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(2_001, 100),
      mode: "replace",
      atBottom: true,
    });
    let transition = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(1_001, 100, 1_050)
    );
    for (const start of [901, 801, 701]) {
      transition = expandMessageContext({
        current: transition.history,
        window: transition.window,
        page: contextPage(start, 101, start + 100),
        direction: "older",
      });
    }
    expect(transition.history.searchContext[0]?.id).toBe("message-701");
    expect(transition.history.searchContext.at(-1)?.id).toBe("message-1100");

    const older = expandMessageContext({
      current: transition.history,
      window: transition.window,
      // Context pages include the requested current edge (701) as well as the
      // 100 new rows. Retaining that overlap alone must not count as progress.
      page: contextPage(601, 101, 701),
      direction: "older",
      viewport: {
        fill: "older-first",
        messageIds: new Set(transition.history.searchContext.slice(-10).map(({ id }) => id)),
      },
    });
    expect(older.history.searchContext[0]?.id).toBe("message-601");
    expect(older.evictedOlder).toBe(0);
    expect(older.evictedNewer).toBe(100);
    expect(older.window.context).toMatchObject({
      hasMoreBefore: true,
      hasMoreAfter: true,
      retentionEdge: "oldest",
    });

    const newer = expandMessageContext({
      current: older.history,
      window: older.window,
      page: contextPage(1_000, 101, 1_000),
      direction: "newer",
      viewport: {
        fill: "newer-first",
        messageIds: new Set(older.history.searchContext.slice(0, 10).map(({ id }) => id)),
      },
    });
    const stats = retainedMessageWindowStats(newer.history, newer.window);
    expect(newer.history.searchContext[0]?.id).toBe("message-701");
    expect(newer.history.searchContext.at(-1)?.id).toBe("message-1100");
    expect(newer.evictedOlder).toBe(100);
    expect(newer.evictedNewer).toBe(0);
    expect(newer.window.context).toMatchObject({
      hasMoreBefore: true,
      hasMoreAfter: true,
      retentionEdge: "newest",
    });
    expect(stats.messages).toBe(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("closing context restores the preserved primary window without mixing lanes", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(901, 100),
      mode: "replace",
      atBottom: true,
    });
    const contextual = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(451, 101, 501)
    );
    const cleared = clearMessageContext(contextual.history, contextual.window);
    expect(cleared.window.context).toBeNull();
    expect(
      visibleChannelHistoryMessages(cleared.history, cleared.window).map(({ id }) => id)
    ).toEqual(initial.history.messages.map(({ id }) => id));
  });

  test("keeps an explicit newer gap when latest messages arrive while context is open", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(901, 100),
      mode: "replace",
      atBottom: true,
    });
    const contextual = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(451, 101, 501)
    );
    const unchanged = applyPrimaryHistoryPage({
      current: contextual.history,
      window: contextual.window,
      page: historyPage(901, 100),
      mode: "refresh",
      atBottom: false,
    });
    expect(unchanged.window.primaryHasNewerGap).toBe(false);

    const refreshed = applyPrimaryHistoryPage({
      current: unchanged.history,
      window: unchanged.window,
      page: historyPage(902, 100),
      mode: "refresh",
      atBottom: false,
    });
    expect(refreshed.window.primaryHasNewerGap).toBe(true);
    expect(refreshed.window.latestTail?.messages.at(-1)?.id).toBe("message-1001");

    const cleared = clearMessageContext(refreshed.history, refreshed.window);
    expect(cleared.history.messages.at(-1)?.id).toBe("message-1000");
    expect(cleared.window.primaryHasNewerGap).toBe(true);
  });

  test("the byte ceiling bounds rich history before the count ceiling", () => {
    const richPage: ChannelHistoryPage = {
      ...historyPage(1, 100),
      messages: messages(1, 100).map((candidate) => ({
        ...candidate,
        content: "x".repeat(30_000),
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPage,
      mode: "replace",
      atBottom: true,
    });
    expect(initial.history.messages.length).toBeLessThan(100);
    expect(initial.window.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(initial.history.messages.at(-1)?.id).toBe("message-100");
  });

  test("reserves byte capacity for a centered lane while retaining the latest tail", () => {
    const richPage: ChannelHistoryPage = {
      ...historyPage(1, 100),
      messages: messages(1, 100).map((candidate) => ({
        ...candidate,
        content: "x".repeat(30_000),
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPage,
      mode: "replace",
      atBottom: true,
    });
    const contextual = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(451, 25, 463)
    );

    expect(contextual.history.searchContext).toHaveLength(25);
    expect(contextual.window.latestTail).not.toBeNull();
    expect(contextual.window.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("enforces the unique-ID ceiling across primary and the latest tail", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(101, 450),
      mode: "replace",
      atBottom: true,
    });
    const older = applyPrimaryHistoryPage({
      current: initial.history,
      window: initial.window,
      page: historyPage(1, 100, false),
      mode: "older",
      atBottom: false,
    });
    const tail = older.window.latestTail;
    expect(tail).not.toBeNull();
    const expected = retainedBytes(
      older.history.messages,
      older.history.threadContext,
      older.history.searchContext,
      older.history.searchThreadContext,
      tail?.messages ?? [],
      tail?.threadContext ?? []
    );
    expect(older.window.retainedBytes).toBe(expected);
    expect(retainedMessageWindowStats(older.history, older.window).messages).toBe(
      MESSAGE_HISTORY_MAX_MESSAGES
    );
  });

  test("enforces one byte ceiling across retained primary, context, threads, and latest tail", () => {
    const richPrimary: ChannelHistoryPage = {
      ...historyPage(901, 100),
      messages: messages(901, 100).map((candidate) => ({
        ...candidate,
        content: `primary ${"p".repeat(12_000)}`,
      })),
    };
    const richContext: ChannelMessageContextView = {
      ...contextPage(451, 101, 501),
      messages: messages(451, 101).map((candidate) => ({
        ...candidate,
        content: `context ${"c".repeat(12_000)}`,
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPrimary,
      mode: "replace",
      atBottom: true,
    });
    const contextual = enterMessageContext(initial.history, initial.window, richContext);
    const tail = contextual.window.latestTail;
    const expected = retainedBytes(
      contextual.history.messages,
      contextual.history.threadContext,
      contextual.history.searchContext,
      contextual.history.searchThreadContext,
      tail?.messages ?? [],
      tail?.threadContext ?? []
    );

    expect(contextual.history.searchContext.length).toBeLessThan(richContext.messages.length);
    expect(
      contextual.history.searchContext.some(({ id }) => id === richContext.targetMessageId)
    ).toBe(true);
    expect(contextual.window.retainedBytes).toBe(expected);
    expect(contextual.window.retainedBytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("rebalances hidden primary and visible context when a disjoint rich latest tail arrives", () => {
    const richPage = (start: number, fill: string): ChannelHistoryPage => ({
      ...historyPage(start, 100),
      messages: messages(start, 100).map((candidate) => ({
        ...candidate,
        content: fill.repeat(12_000),
      })),
    });
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPage(901, "p"),
      mode: "replace",
      atBottom: true,
    });
    const context: ChannelMessageContextView = {
      ...contextPage(451, 101, 501),
      messages: messages(451, 101).map((candidate) => ({
        ...candidate,
        content: "c".repeat(4_000),
      })),
    };
    const contextual = enterMessageContext(initial.history, initial.window, context);
    const refreshed = applyPrimaryHistoryPage({
      current: contextual.history,
      window: contextual.window,
      page: richPage(1_001, "n"),
      mode: "refresh",
      atBottom: false,
    });
    const tail = refreshed.window.latestTail;
    const expected = retainedBytes(
      refreshed.history.messages,
      refreshed.history.threadContext,
      refreshed.history.searchContext,
      refreshed.history.searchThreadContext,
      tail?.messages ?? [],
      tail?.threadContext ?? []
    );

    expect(refreshed.window.primaryHasNewerGap).toBe(true);
    expect(refreshed.window.context?.hasMoreAfter).toBe(true);
    expect(refreshed.window.retainedBytes).toBe(expected);
    expect(refreshed.window.retainedBytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("uses reserved context capacity without double-counting its overlapping tail", () => {
    const nearlyFullPrimary: ChannelHistoryPage = {
      ...historyPage(901, 100),
      messages: messages(901, 100).map((candidate) => ({
        ...candidate,
        content: "p".repeat(21_000),
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: nearlyFullPrimary,
      mode: "replace",
      atBottom: true,
    });
    const contextual = enterMessageContext(
      initial.history,
      initial.window,
      contextPage(451, 101, 551)
    );

    expect(initial.window.retainedBytes).toBeGreaterThan(
      MESSAGE_HISTORY_MAX_RETAINED_BYTES - 64 * 1024
    );
    expect(contextual.history.searchContext).toHaveLength(101);
    expect(contextual.window.retainedBytes).toBe(
      retainedBytes(
        contextual.history.messages,
        contextual.history.threadContext,
        contextual.history.searchContext,
        contextual.history.searchThreadContext,
        contextual.window.latestTail?.messages ?? [],
        contextual.window.latestTail?.threadContext ?? []
      )
    );
    expect(contextual.window.retainedBytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("hard-bounds a disjoint primary, centered context, and cached tail to 500 unique IDs", () => {
    let transition = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(501, 100),
      mode: "replace",
      atBottom: true,
    });
    for (const start of [401, 301, 201, 101, 1]) {
      transition = applyPrimaryHistoryPage({
        current: transition.history,
        window: transition.window,
        page: historyPage(start, 100, start !== 1),
        mode: "older",
        atBottom: false,
      });
    }
    const contextual = enterMessageContext(
      transition.history,
      transition.window,
      contextPage(1_001, 500, 1_250)
    );
    const stats = retainedMessageWindowStats(contextual.history, contextual.window);

    expect(contextual.history.searchContext).toHaveLength(400);
    expect(contextual.window.latestTail?.messages).toHaveLength(100);
    expect(contextual.history.messages).toHaveLength(0);
    expect(stats.messages).toBe(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBe(contextual.window.retainedBytes);
  });

  test("trims lower-priority rich lanes instead of exceeding the exact 2 MiB union cap", () => {
    const richPrimary: ChannelHistoryPage = {
      ...historyPage(1, 100),
      messages: messages(1, 100).map((candidate) => ({
        ...candidate,
        content: "p".repeat(20_500),
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPrimary,
      mode: "replace",
      atBottom: true,
    });
    const richContext: ChannelMessageContextView = {
      ...contextPage(1_000, 101, 1_050),
      messages: messages(1_000, 101).map((candidate) => ({
        ...candidate,
        content: "c".repeat(1_000),
      })),
    };
    const contextual = enterMessageContext(initial.history, initial.window, richContext);
    const stats = retainedMessageWindowStats(contextual.history, contextual.window);

    expect(
      contextual.history.searchContext.some(({ id }) => id === richContext.targetMessageId)
    ).toBe(true);
    expect(stats.bytes).toBe(contextual.window.retainedBytes);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
  });

  test("pivots a rich older page around the visible rows without losing the scroll anchor", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(101, 500),
      mode: "replace",
      atBottom: true,
    });
    const richOlder: ChannelHistoryPage = {
      ...historyPage(1, 100, false),
      messages: messages(1, 100).map((candidate) => ({
        ...candidate,
        content: "x".repeat(30_000),
      })),
    };
    const older = applyPrimaryHistoryPage({
      current: initial.history,
      window: initial.window,
      page: richOlder,
      mode: "older",
      atBottom: false,
      viewport: {
        fill: "older-first",
        messageIds: new Set(["message-101", "message-102"]),
      },
    });
    const stats = retainedMessageWindowStats(older.history, older.window);

    expect(older.history.messages.some(({ id }) => id === "message-101")).toBe(true);
    expect(older.history.messages.some(({ id }) => id === "message-102")).toBe(true);
    expect(older.history.messages[0]?.id).not.toBe("message-1");
    expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
  });

  test("advances older pagination when a stale viewport would discard the requested page", () => {
    let transition = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(1_001, 100),
      mode: "replace",
      atBottom: true,
    });
    for (const start of [901, 801, 701, 601, 501]) {
      transition = applyPrimaryHistoryPage({
        current: transition.history,
        window: transition.window,
        page: historyPage(start, 100),
        mode: "older",
        atBottom: false,
        viewport: {
          fill: "older-first",
          messageIds: new Set(transition.history.messages.slice(0, 10).map(({ id }) => id)),
        },
      });
    }
    expect(transition.history.beforeSequence).toBe("501");
    expect(transition.history.messages).toHaveLength(
      MESSAGE_HISTORY_MAX_MESSAGES - MESSAGE_HISTORY_PAGE_SIZE
    );
    expect(transition.window.latestTail?.messages).toHaveLength(MESSAGE_HISTORY_PAGE_SIZE);

    const staleViewportIds = new Set(transition.history.messages.slice(-10).map(({ id }) => id));
    const older = applyPrimaryHistoryPage({
      current: transition.history,
      window: transition.window,
      page: historyPage(401, 100),
      mode: "older",
      atBottom: false,
      viewport: { fill: "older-first", messageIds: staleViewportIds },
    });
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

  test("keeps the live-refresh viewport and preserves runway in the reported scroll direction", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(1, 500),
      mode: "replace",
      atBottom: true,
    });
    const refreshPage = historyPage(402, 100);
    const apply = (fill: "older-first" | "newer-first", window = initial.window) =>
      applyPrimaryHistoryPage({
        current: initial.history,
        window,
        page: refreshPage,
        mode: "refresh",
        atBottom: false,
        viewport: {
          fill,
          messageIds: new Set(["message-450", "message-495"]),
        },
      });
    const movingOlder = apply("older-first");
    const movingNewer = apply("newer-first");
    const existingGap = apply("newer-first", {
      ...initial.window,
      primaryHasNewerGap: true,
    });

    for (const transition of [movingOlder, movingNewer, existingGap]) {
      expect(transition.history.messages.some(({ id }) => id === "message-450")).toBe(true);
      expect(transition.history.messages.some(({ id }) => id === "message-495")).toBe(true);
      const stats = retainedMessageWindowStats(transition.history, transition.window);
      expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
      expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    }
    expect(Number(movingNewer.history.messages.at(-1)?.sequence)).toBeGreaterThan(
      Number(movingOlder.history.messages.at(-1)?.sequence)
    );
  });

  test("allows only an indivisible oversized visible message to be a byte soft excess", () => {
    const oversized = message(1, "x".repeat(MESSAGE_HISTORY_MAX_RETAINED_BYTES + 1));
    const transition = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: { ...historyPage(1, 1, false), messages: [oversized] },
      mode: "replace",
      atBottom: true,
    });
    const stats = retainedMessageWindowStats(transition.history, transition.window);

    expect(stats.messages).toBe(1);
    expect(stats.bytes).toBeGreaterThan(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    expect(transition.history.messages).toEqual([oversized]);
    expect(transition.window.latestTail).toBeNull();
  });

  test("patches every retained copy, recomputes exact bytes, and invalidates context loading", () => {
    const root = message(1);
    const reply = { ...message(1_000), metadata: { replyTo: root.id } };
    const initialHistory = {
      ...emptyLoadedChannelHistory(),
      messages: [root],
      loadedAt: 1,
    };
    const entered = enterMessageContext(initialHistory, emptyChannelMessageWindow(), {
      ...contextPage(1, 1, 1, false, false),
      messages: [root],
      threadContext: [],
    });
    const withTail = {
      ...entered.window,
      latestTail: {
        messages: [reply],
        threadContext: [root],
        threadContextTruncated: false,
        beforeSequence: reply.sequence,
        hasMore: true,
        revision: "1",
        retainedBytes: retainedBytes([reply], [root]),
      },
    };
    withTail.retainedBytes = retainedBytes(
      entered.history.messages,
      entered.history.threadContext,
      entered.history.searchContext,
      entered.history.searchThreadContext,
      withTail.latestTail.messages,
      withTail.latestTail.threadContext
    );
    const loadingWindow = setContextLoading(withTail, "newer");
    const updated = {
      ...root,
      content: "updated root with reaction metadata",
      metadata: { reactions: [] },
    };
    const patched = patchRetainedMessageWindow(entered.history, loadingWindow, updated);

    expect(patched).not.toBeNull();
    expect(patched?.window.generation).toBe(loadingWindow.generation + 1);
    expect(patched?.window.context?.loadingDirection).toBeNull();
    expect(patched?.history.messages.find(({ id }) => id === root.id)).toBe(updated);
    expect(patched?.history.searchContext.find(({ id }) => id === root.id)).toBe(updated);
    expect(patched?.window.latestTail?.threadContext.find(({ id }) => id === root.id)).toBe(
      updated
    );
    if (!patched) throw new Error("expected patched retained state");
    const stats = retainedMessageWindowStats(patched.history, patched.window);
    expect(stats.bytes).toBe(patched.window.retainedBytes);
    expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    const reset = resetToLatestTail(patched.history, patched.window);
    expect(reset?.history.threadContext.find(({ id }) => id === root.id)).toBe(updated);
  });

  test("re-bounds the retained union when a patched visible message grows", () => {
    const richPage: ChannelHistoryPage = {
      ...historyPage(1, 300, false),
      messages: messages(1, 300).map((candidate) => ({
        ...candidate,
        content: "x".repeat(5_000),
      })),
    };
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: richPage,
      mode: "replace",
      atBottom: true,
    });
    const originalCount = initial.history.messages.length;
    const updated = {
      ...(initial.history.messages.at(-1) as ChannelMessageView),
      content: "y".repeat(1_000_000),
    };
    const patched = patchRetainedMessageWindow(initial.history, initial.window, updated, {
      fill: "newer-first",
      messageIds: new Set([updated.id]),
    });

    expect(patched).not.toBeNull();
    if (!patched) throw new Error("expected patched retained state");
    const stats = retainedMessageWindowStats(patched.history, patched.window);
    expect(patched.history.messages.find(({ id }) => id === updated.id)).toBe(updated);
    expect(patched.history.messages.length).toBeLessThan(originalCount);
    expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    expect(stats.bytes).toBe(patched.window.retainedBytes);
  });

  test("evicts a distant oversized patch instead of protecting its edge-to-row range", () => {
    const initial = applyPrimaryHistoryPage({
      current: undefined,
      window: undefined,
      page: historyPage(1, 500, false),
      mode: "replace",
      atBottom: true,
    });
    const updated = {
      ...(initial.history.messages[249] as ChannelMessageView),
      content: "z".repeat(MESSAGE_HISTORY_MAX_RETAINED_BYTES + 1),
    };
    const patched = patchRetainedMessageWindow(initial.history, initial.window, updated);

    expect(patched).not.toBeNull();
    if (!patched) throw new Error("expected patched retained state");
    const stats = retainedMessageWindowStats(patched.history, patched.window);
    expect(patched.history.messages.some(({ id }) => id === updated.id)).toBe(false);
    expect(stats.messages).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(stats.bytes).toBeLessThanOrEqual(MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    expect(stats.bytes).toBe(patched.window.retainedBytes);
  });
});
