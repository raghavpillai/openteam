import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "@openbot/contracts";
import type { LoadedChannelHistory } from "@openbot/product-core/history";
import {
  clearLoadedChannelSearchContext,
  compareEntitySequence,
  emptyLoadedChannelHistory,
  mergeLoadedChannelHistoryPage,
  sortedUniqueMessages,
} from "@openbot/product-core/history";
import {
  type BoundMessageWindowOptions,
  boundMessageWindow,
  latestRefreshOverlap,
  messageRetainedByteSize,
} from "@openbot/product-core/message-window";

export const MESSAGE_HISTORY_PAGE_SIZE = 100;
export const MESSAGE_HISTORY_MAX_MESSAGES = 500;
export const MESSAGE_HISTORY_MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const MIN_VISIBLE_WINDOW_BYTES = 64 * 1024;
const MAX_RETAINED_REBALANCE_PASSES = 4;

export type MessageHistoryDirection = "older" | "newer";

export interface MessageContextWindowState {
  targetMessageId: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadingDirection: MessageHistoryDirection | null;
}

export interface MessageLatestTail {
  messages: ChannelMessageView[];
  threadContext: ChannelMessageView[];
  threadContextTruncated: boolean;
  beforeSequence: string | null;
  hasMore: boolean;
  revision: string;
  retainedBytes: number;
}

export interface ChannelMessageWindowState {
  generation: number;
  primaryHasNewerGap: boolean;
  context: MessageContextWindowState | null;
  latestTail: MessageLatestTail | null;
  retainedBytes: number;
}

export interface MessageWindowTransition {
  history: LoadedChannelHistory;
  window: ChannelMessageWindowState;
  outcome: "applied" | "preserved-gap";
  evictedOlder: number;
  evictedNewer: number;
}

export const emptyChannelMessageWindow = (): ChannelMessageWindowState => ({
  generation: 0,
  primaryHasNewerGap: false,
  context: null,
  latestTail: null,
  retainedBytes: 0,
});

const uniqueRetainedBytes = (...lanes: ReadonlyArray<readonly ChannelMessageView[]>): number => {
  const byId = new Map<string, ChannelMessageView>();
  for (const lane of lanes) for (const message of lane) byId.set(message.id, message);
  let total = 0;
  for (const message of byId.values()) total += messageRetainedByteSize(message);
  return total;
};

const latestTailLanes = (
  latestTail: MessageLatestTail | null
): ReadonlyArray<readonly ChannelMessageView[]> =>
  latestTail ? [latestTail.messages, latestTail.threadContext] : [];

const retainedStateBytes = (
  history: LoadedChannelHistory,
  latestTail: MessageLatestTail | null
): number =>
  uniqueRetainedBytes(
    history.messages,
    history.threadContext,
    history.searchContext,
    history.searchThreadContext,
    ...latestTailLanes(latestTail)
  );

const retainedContextTargetId = (
  targetMessageId: string,
  candidates: readonly ChannelMessageView[],
  retained: readonly ChannelMessageView[]
): string => {
  if (retained.some((message) => message.id === targetMessageId)) return targetMessageId;
  const candidateIndexById = new Map(
    candidates.map((message, index) => [message.id, index] as const)
  );
  const targetIndex = candidateIndexById.get(targetMessageId);
  if (targetIndex === undefined) return retained[0]?.id ?? targetMessageId;
  let nearest = retained[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const message of retained) {
    const index = candidateIndexById.get(message.id);
    if (index === undefined) continue;
    const distance = Math.abs(index - targetIndex);
    if (distance < nearestDistance) {
      nearest = message;
      nearestDistance = distance;
    }
  }
  return nearest?.id ?? targetMessageId;
};

type RetainedLaneOptions = Omit<BoundMessageWindowOptions, "maxBytes">;

/**
 * Bound one lane against every other retained lane. Starting with the full
 * ceiling lets IDs shared with a cached tail consume bytes only once. If the
 * exact union is still too large, the active lane is tightened until the
 * union fits or reaches the documented minimum/indivisible soft excess.
 */
const boundRetainedLane = (
  messages: readonly ChannelMessageView[],
  options: RetainedLaneOptions,
  otherLanes: ReadonlyArray<readonly ChannelMessageView[]>
): ReturnType<typeof boundMessageWindow> => {
  let maxBytes = MESSAGE_HISTORY_MAX_RETAINED_BYTES;
  let bounded = boundMessageWindow(messages, { ...options, maxBytes });
  for (let attempt = 0; attempt < MAX_RETAINED_REBALANCE_PASSES; attempt += 1) {
    const total = uniqueRetainedBytes(bounded.messages, bounded.threadContext, ...otherLanes);
    if (total <= MESSAGE_HISTORY_MAX_RETAINED_BYTES) return bounded;
    const excess = total - MESSAGE_HISTORY_MAX_RETAINED_BYTES;
    const nextMaxBytes = Math.max(MIN_VISIBLE_WINDOW_BYTES, bounded.retainedBytes - excess);
    if (nextMaxBytes >= maxBytes) return bounded;
    maxBytes = nextMaxBytes;
    bounded = boundMessageWindow(messages, { ...options, maxBytes });
  }
  // A pathological overlap layout can evict IDs that remain in another lane,
  // producing little union reduction per pass. Fall back to treating every
  // active byte as marginal so rebalance work stays bounded on the UI thread.
  const conservativeMaxBytes = Math.max(
    MIN_VISIBLE_WINDOW_BYTES,
    MESSAGE_HISTORY_MAX_RETAINED_BYTES - uniqueRetainedBytes(...otherLanes)
  );
  return conservativeMaxBytes < maxBytes
    ? boundMessageWindow(messages, { ...options, maxBytes: conservativeMaxBytes })
    : bounded;
};

const boundedHistory = (
  history: LoadedChannelHistory,
  retain: "oldest" | "newest",
  maxBytes: number,
  gaps: { older: boolean; newer: boolean },
  protectedIds?: ReadonlySet<string>
) =>
  boundMessageWindow(history.messages, {
    maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
    maxBytes,
    retain,
    protectedIds,
    threadContext: history.threadContext,
    existingGaps: gaps,
  });

const boundedHistoryAgainst = (
  history: LoadedChannelHistory,
  retain: "oldest" | "newest",
  gaps: { older: boolean; newer: boolean },
  otherLanes: ReadonlyArray<readonly ChannelMessageView[]>,
  protectedIds?: ReadonlySet<string>
) =>
  boundRetainedLane(
    history.messages,
    {
      maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
      retain,
      protectedIds,
      threadContext: history.threadContext,
      existingGaps: gaps,
    },
    otherLanes
  );

const withBoundedPrimary = (
  history: LoadedChannelHistory,
  bounded: ReturnType<typeof boundedHistory>
): LoadedChannelHistory => ({
  ...history,
  messages: bounded.messages,
  threadContext: bounded.threadContext,
  beforeSequence: bounded.messages[0]?.sequence ?? null,
  hasMore: bounded.gaps.older,
  loading: false,
});

const tailFromMessages = ({
  messages,
  threadContext,
  threadContextTruncated,
  hasMore,
  revision,
}: {
  messages: readonly ChannelMessageView[];
  threadContext: readonly ChannelMessageView[];
  threadContextTruncated: boolean;
  hasMore: boolean;
  revision: string;
}): MessageLatestTail => {
  const candidates = sortedUniqueMessages(messages)
    .sort(compareEntitySequence)
    .slice(-MESSAGE_HISTORY_PAGE_SIZE);
  const bounded = boundMessageWindow(candidates, {
    maxMessages: MESSAGE_HISTORY_PAGE_SIZE,
    // Keep a small lane available for a centered target while this tail is
    // retained offscreen. A single indivisible oversized message remains the
    // shared window helper's documented soft-excess case.
    maxBytes: MESSAGE_HISTORY_MAX_RETAINED_BYTES - MIN_VISIBLE_WINDOW_BYTES,
    retain: "newest",
    threadContext: [...messages, ...threadContext],
    existingGaps: { older: hasMore || messages.length > candidates.length },
  });
  return {
    messages: bounded.messages,
    threadContext: bounded.threadContext,
    threadContextTruncated,
    beforeSequence: bounded.messages[0]?.sequence ?? null,
    hasMore: bounded.gaps.older,
    revision,
    retainedBytes: bounded.retainedBytes,
  };
};

export const latestTailFromPage = (page: ChannelHistoryPage): MessageLatestTail =>
  tailFromMessages({
    messages: page.messages,
    threadContext: page.threadContext,
    threadContextTruncated: page.threadContextTruncated,
    hasMore: page.hasMore,
    revision: page.revision,
  });

export const latestTailFromHistory = (history: LoadedChannelHistory): MessageLatestTail =>
  tailFromMessages({
    messages: history.messages,
    threadContext: history.threadContext,
    threadContextTruncated: history.threadContextTruncated,
    hasMore: history.hasMore,
    revision: "0",
  });

export const visibleChannelHistoryMessages = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState
): ChannelMessageView[] =>
  sortedUniqueMessages(
    window.context
      ? [...history.searchThreadContext, ...history.searchContext]
      : [...history.threadContext, ...history.messages]
  ).sort(compareEntitySequence);

const preservedHistory = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState,
  page: ChannelHistoryPage,
  loadedAt: number,
  context: MessageContextWindowState | null = window.context
): MessageWindowTransition => {
  const latestTail = latestTailFromPage(page);
  const contextIds = new Set(history.searchContext.map((message) => message.id));
  const primaryIds = new Set(history.messages.map((message) => message.id));
  const newestLatestId = latestTail.messages.at(-1)?.id;
  const nextContext =
    context && newestLatestId && !contextIds.has(newestLatestId)
      ? { ...context, hasMoreAfter: true }
      : context;
  const primaryMissesLatest = Boolean(newestLatestId && !primaryIds.has(newestLatestId));
  let primaryHasNewerGap =
    window.primaryHasNewerGap || window.context === null || primaryMissesLatest;
  let nextHistory: LoadedChannelHistory = { ...history, loading: false, loadedAt };
  let boundedContext = nextContext;
  let evictedOlder = 0;
  let evictedNewer = 0;

  if (nextContext) {
    const boundedPrimary = boundedHistoryAgainst(
      nextHistory,
      "oldest",
      { older: history.hasMore, newer: primaryHasNewerGap },
      [history.searchContext, history.searchThreadContext, ...latestTailLanes(latestTail)]
    );
    nextHistory = withBoundedPrimary(nextHistory, boundedPrimary);
    primaryHasNewerGap = boundedPrimary.gaps.newer;
    evictedOlder += boundedPrimary.eviction.older?.count ?? 0;
    evictedNewer += boundedPrimary.eviction.newer?.count ?? 0;

    const contextMessages = sortedUniqueMessages(history.searchContext).sort(compareEntitySequence);
    const bounded = boundRetainedLane(
      contextMessages,
      {
        maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
        retain: "newest",
        threadContext: history.searchThreadContext,
        existingGaps: {
          older: nextContext.hasMoreBefore,
          newer: nextContext.hasMoreAfter,
        },
      },
      [nextHistory.messages, nextHistory.threadContext, ...latestTailLanes(latestTail)]
    );
    nextHistory = contextHistory(
      nextHistory,
      bounded.messages,
      bounded.threadContext,
      history.searchThreadContextTruncated,
      loadedAt
    );
    boundedContext = {
      ...nextContext,
      targetMessageId: retainedContextTargetId(nextContext.targetMessageId, contextMessages, [
        ...bounded.threadContext,
        ...bounded.messages,
      ]),
      hasMoreBefore: bounded.gaps.older,
      hasMoreAfter: bounded.gaps.newer,
      loadingDirection: null,
    };
    evictedOlder += bounded.eviction.older?.count ?? 0;
    evictedNewer += bounded.eviction.newer?.count ?? 0;
  } else {
    const bounded = boundedHistoryAgainst(
      nextHistory,
      "oldest",
      { older: history.hasMore, newer: primaryHasNewerGap },
      [history.searchContext, history.searchThreadContext, ...latestTailLanes(latestTail)]
    );
    nextHistory = withBoundedPrimary(nextHistory, bounded);
    primaryHasNewerGap = bounded.gaps.newer;
    evictedOlder += bounded.eviction.older?.count ?? 0;
    evictedNewer += bounded.eviction.newer?.count ?? 0;
  }

  return {
    history: nextHistory,
    window: {
      ...window,
      primaryHasNewerGap,
      context: boundedContext,
      latestTail,
      retainedBytes: retainedStateBytes(nextHistory, latestTail),
    },
    outcome: "preserved-gap",
    evictedOlder,
    evictedNewer,
  };
};

export const applyPrimaryHistoryPage = ({
  current,
  window,
  page,
  mode,
  atBottom,
  loadedAt = Date.now(),
}: {
  current: LoadedChannelHistory | undefined;
  window: ChannelMessageWindowState | undefined;
  page: ChannelHistoryPage;
  mode: "replace" | "refresh" | "older";
  atBottom: boolean;
  loadedAt?: number;
}): MessageWindowTransition => {
  const base = current ?? emptyLoadedChannelHistory();
  const state = window ?? emptyChannelMessageWindow();

  if (mode === "replace" || base.loadedAt === 0) {
    const merged = mergeLoadedChannelHistoryPage(base, page, "replace", loadedAt);
    const bounded = boundedHistory(merged, "newest", MESSAGE_HISTORY_MAX_RETAINED_BYTES, {
      older: page.hasMore,
      newer: false,
    });
    const history = clearLoadedChannelSearchContext(withBoundedPrimary(merged, bounded));
    return {
      history,
      window: {
        generation: state.generation + 1,
        primaryHasNewerGap: false,
        context: null,
        latestTail: null,
        retainedBytes: retainedStateBytes(history, null),
      },
      outcome: "applied",
      evictedOlder: bounded.eviction.older?.count ?? 0,
      evictedNewer: bounded.eviction.newer?.count ?? 0,
    };
  }

  if (mode === "older") {
    const merged = mergeLoadedChannelHistoryPage(base, page, "older", loadedAt);
    const firstPass = boundedHistory(merged, "oldest", MESSAGE_HISTORY_MAX_RETAINED_BYTES, {
      older: page.hasMore,
      newer: state.primaryHasNewerGap,
    });
    const needsTail = state.primaryHasNewerGap || firstPass.eviction.newer !== null;
    const latestTail = needsTail ? (state.latestTail ?? latestTailFromHistory(base)) : null;
    const bounded = boundedHistoryAgainst(
      merged,
      "oldest",
      {
        older: page.hasMore,
        newer: state.primaryHasNewerGap,
      },
      [merged.searchContext, merged.searchThreadContext, ...latestTailLanes(latestTail)]
    );
    const history = withBoundedPrimary(merged, bounded);
    return {
      history,
      window: {
        ...state,
        primaryHasNewerGap: bounded.gaps.newer,
        latestTail,
        retainedBytes: retainedStateBytes(history, latestTail),
      },
      outcome: "applied",
      evictedOlder: bounded.eviction.older?.count ?? 0,
      evictedNewer: bounded.eviction.newer?.count ?? 0,
    };
  }

  if (state.context || state.primaryHasNewerGap) {
    return preservedHistory(base, state, page, loadedAt);
  }

  const overlap = latestRefreshOverlap(base.messages, page.messages);
  if (overlap.requiresReset && !atBottom) {
    return preservedHistory(base, state, page, loadedAt);
  }

  const merged = mergeLoadedChannelHistoryPage(
    base,
    page,
    overlap.requiresReset ? "replace" : "refresh",
    loadedAt
  );
  const bounded = boundedHistory(merged, "newest", MESSAGE_HISTORY_MAX_RETAINED_BYTES, {
    older: page.hasMore || base.hasMore,
    newer: false,
  });
  if (bounded.eviction.older && !atBottom) {
    return preservedHistory(base, state, page, loadedAt);
  }

  const history = withBoundedPrimary(merged, bounded);
  return {
    history,
    window: {
      ...state,
      primaryHasNewerGap: false,
      latestTail: null,
      retainedBytes: retainedStateBytes(history, null),
    },
    outcome: "applied",
    evictedOlder: bounded.eviction.older?.count ?? 0,
    evictedNewer: bounded.eviction.newer?.count ?? 0,
  };
};

const contextHistory = (
  current: LoadedChannelHistory,
  messages: readonly ChannelMessageView[],
  threadContext: readonly ChannelMessageView[],
  truncated: boolean,
  loadedAt: number
): LoadedChannelHistory => ({
  ...current,
  searchContext: [...messages],
  searchThreadContext: [...threadContext],
  searchThreadContextTruncated: truncated,
  loading: false,
  loadedAt,
});

export const enterMessageContext = (
  current: LoadedChannelHistory,
  window: ChannelMessageWindowState,
  context: ChannelMessageContextView,
  loadedAt = Date.now()
): MessageWindowTransition => {
  const latestTail = window.latestTail ?? latestTailFromHistory(current);
  const bounded = boundRetainedLane(
    context.messages,
    {
      maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
      retain: "newest",
      protectedIds: new Set([context.targetMessageId]),
      threadContext: context.threadContext,
      existingGaps: {
        older: context.hasMoreBefore,
        newer: context.hasMoreAfter,
      },
    },
    [current.messages, current.threadContext, ...latestTailLanes(latestTail)]
  );
  const history = contextHistory(
    current,
    bounded.messages,
    bounded.threadContext,
    context.threadContextTruncated,
    loadedAt
  );
  return {
    history,
    window: {
      ...window,
      generation: window.generation + 1,
      context: {
        targetMessageId: context.targetMessageId,
        hasMoreBefore: bounded.gaps.older,
        hasMoreAfter: bounded.gaps.newer,
        loadingDirection: null,
      },
      latestTail,
      retainedBytes: retainedStateBytes(history, latestTail),
    },
    outcome: "applied",
    evictedOlder: bounded.eviction.older?.count ?? 0,
    evictedNewer: bounded.eviction.newer?.count ?? 0,
  };
};

export const setContextLoading = (
  window: ChannelMessageWindowState,
  direction: MessageHistoryDirection | null
): ChannelMessageWindowState =>
  window.context
    ? { ...window, context: { ...window.context, loadingDirection: direction } }
    : window;

export const expandMessageContext = ({
  current,
  window,
  page,
  direction,
  loadedAt = Date.now(),
}: {
  current: LoadedChannelHistory;
  window: ChannelMessageWindowState;
  page: ChannelMessageContextView;
  direction: MessageHistoryDirection;
  loadedAt?: number;
}): MessageWindowTransition => {
  if (!window.context) {
    return enterMessageContext(current, window, page, loadedAt);
  }
  const messages = sortedUniqueMessages([...current.searchContext, ...page.messages]).sort(
    compareEntitySequence
  );
  const threadContext = sortedUniqueMessages([
    ...current.searchThreadContext,
    ...page.threadContext,
    ...current.searchContext,
  ]).sort(compareEntitySequence);
  const bounded = boundRetainedLane(
    messages,
    {
      maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
      retain: direction === "older" ? "oldest" : "newest",
      threadContext,
      existingGaps: {
        older: direction === "older" ? page.hasMoreBefore : window.context.hasMoreBefore,
        newer: direction === "newer" ? page.hasMoreAfter : window.context.hasMoreAfter,
      },
    },
    [current.messages, current.threadContext, ...latestTailLanes(window.latestTail)]
  );
  const history = contextHistory(
    current,
    bounded.messages,
    bounded.threadContext,
    current.searchThreadContextTruncated || page.threadContextTruncated,
    loadedAt
  );
  return {
    history,
    window: {
      ...window,
      context: {
        ...window.context,
        targetMessageId: retainedContextTargetId(window.context.targetMessageId, messages, [
          ...bounded.threadContext,
          ...bounded.messages,
        ]),
        hasMoreBefore: bounded.gaps.older,
        hasMoreAfter: bounded.gaps.newer,
        loadingDirection: null,
      },
      retainedBytes: retainedStateBytes(history, window.latestTail),
    },
    outcome: "applied",
    evictedOlder: bounded.eviction.older?.count ?? 0,
    evictedNewer: bounded.eviction.newer?.count ?? 0,
  };
};

export const clearMessageContext = (
  current: LoadedChannelHistory,
  window: ChannelMessageWindowState
): MessageWindowTransition => {
  const history = clearLoadedChannelSearchContext(current);
  return {
    history,
    window: {
      ...window,
      generation: window.generation + 1,
      context: null,
      retainedBytes: retainedStateBytes(history, window.latestTail),
    },
    outcome: "applied",
    evictedOlder: 0,
    evictedNewer: 0,
  };
};

export const resetToLatestTail = (
  current: LoadedChannelHistory,
  window: ChannelMessageWindowState,
  loadedAt = Date.now()
): MessageWindowTransition | null => {
  const tail = window.latestTail;
  if (!tail) return null;
  const history: LoadedChannelHistory = {
    ...current,
    messages: tail.messages,
    threadContext: tail.threadContext,
    threadContextTruncated: tail.threadContextTruncated,
    searchContext: [],
    searchThreadContext: [],
    searchThreadContextTruncated: false,
    beforeSequence: tail.beforeSequence,
    hasMore: tail.hasMore,
    loading: false,
    loadedAt,
  };
  return {
    history,
    window: {
      generation: window.generation + 1,
      primaryHasNewerGap: false,
      context: null,
      latestTail: null,
      retainedBytes: retainedStateBytes(history, null),
    },
    outcome: "applied",
    evictedOlder: 0,
    evictedNewer: 0,
  };
};
