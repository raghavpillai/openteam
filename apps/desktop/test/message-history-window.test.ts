import { describe, expect, test } from "bun:test";
import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "@openbot/contracts";
import { emptyLoadedChannelHistory } from "@openbot/product-core/history";
import { messageRetainedByteSize } from "@openbot/product-core/message-window";
import {
  applyPrimaryHistoryPage,
  clearMessageContext,
  emptyChannelMessageWindow,
  enterMessageContext,
  expandMessageContext,
  MESSAGE_HISTORY_MAX_MESSAGES,
  MESSAGE_HISTORY_MAX_RETAINED_BYTES,
  resetToLatestTail,
  visibleChannelHistoryMessages,
} from "../src/renderer/lib/message-history-window";

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
  test("keeps normal history unchanged through five pages, then evicts only the newer edge", () => {
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
    expect(transition.history.messages).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(transition.history.messages[0]?.id).toBe("message-1");
    expect(transition.history.messages.at(-1)?.id).toBe("message-500");
    expect(transition.evictedNewer).toBe(100);
    expect(transition.window.primaryHasNewerGap).toBe(true);
    expect(transition.window.latestTail?.messages.at(-1)?.id).toBe("message-600");
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

    expect(transition.history.searchContext).toHaveLength(MESSAGE_HISTORY_MAX_MESSAGES);
    expect(
      transition.history.searchContext.some((candidate) => candidate.id === "message-1051")
    ).toBe(false);
    expect(
      transition.history.searchContext.some(
        (candidate) => candidate.id === transition.window.context?.targetMessageId
      )
    ).toBe(true);
    expect(transition.window.context?.targetMessageId).toBe("message-1000");
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

  test("deduplicates overlapping primary and latest-tail bytes across the full retained state", () => {
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
    const doubleCounted =
      retainedBytes(older.history.messages, older.history.threadContext) +
      retainedBytes(tail?.messages ?? [], tail?.threadContext ?? []);

    expect(older.window.retainedBytes).toBe(expected);
    expect(older.window.retainedBytes).toBeLessThan(doubleCounted);
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
});
