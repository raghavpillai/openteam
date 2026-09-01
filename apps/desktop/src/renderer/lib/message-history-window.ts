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
  boundMessageWindow,
  latestRefreshOverlap,
  messageRetainedByteSize,
} from "@openbot/product-core/message-window";

export const MESSAGE_HISTORY_PAGE_SIZE = 100;
export const MESSAGE_HISTORY_MAX_MESSAGES = 500;
export const MESSAGE_HISTORY_MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const MIN_VISIBLE_WINDOW_BYTES = 64 * 1024;

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

const visibleByteBudget = (latestTail: MessageLatestTail | null): number =>
  Math.max(1, MESSAGE_HISTORY_MAX_RETAINED_BYTES - (latestTail?.retainedBytes ?? 0));

const retainedBytesWithTail = (
  messages: readonly ChannelMessageView[],
  threadContext: readonly ChannelMessageView[],
  latestTail: MessageLatestTail | null
): number =>
  uniqueRetainedBytes(
    messages,
    threadContext,
    latestTail?.messages ?? [],
    latestTail?.threadContext ?? []
  );

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
  return {
    history: { ...history, loading: false, loadedAt: Date.now() },
    window: {
      ...window,
      primaryHasNewerGap:
        window.primaryHasNewerGap || window.context === null || primaryMissesLatest,
      context: nextContext,
      latestTail,
      retainedBytes: retainedBytesWithTail(
        window.context ? history.searchContext : history.messages,
        window.context ? history.searchThreadContext : history.threadContext,
        latestTail
      ),
    },
    outcome: "preserved-gap",
    evictedOlder: 0,
    evictedNewer: 0,
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
        retainedBytes: bounded.retainedBytes,
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
    const bounded = boundedHistory(merged, "oldest", visibleByteBudget(latestTail), {
      older: page.hasMore,
      newer: state.primaryHasNewerGap,
    });
    const history = withBoundedPrimary(merged, bounded);
    return {
      history,
      window: {
        ...state,
        primaryHasNewerGap: bounded.gaps.newer,
        latestTail,
        retainedBytes: retainedBytesWithTail(history.messages, history.threadContext, latestTail),
      },
      outcome: "applied",
      evictedOlder: bounded.eviction.older?.count ?? 0,
      evictedNewer: bounded.eviction.newer?.count ?? 0,
    };
  }

  if (state.context || state.primaryHasNewerGap) {
    return preservedHistory(base, state, page);
  }

  const overlap = latestRefreshOverlap(base.messages, page.messages);
  if (overlap.requiresReset && !atBottom) return preservedHistory(base, state, page);

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
  if (bounded.eviction.older && !atBottom) return preservedHistory(base, state, page);

  return {
    history: withBoundedPrimary(merged, bounded),
    window: {
      ...state,
      primaryHasNewerGap: false,
      latestTail: null,
      retainedBytes: bounded.retainedBytes,
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
  const bounded = boundMessageWindow(context.messages, {
    maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
    maxBytes: visibleByteBudget(latestTail),
    retain: "newest",
    protectedIds: new Set([context.targetMessageId]),
    threadContext: context.threadContext,
    existingGaps: {
      older: context.hasMoreBefore,
      newer: context.hasMoreAfter,
    },
  });
  return {
    history: contextHistory(
      current,
      bounded.messages,
      bounded.threadContext,
      context.threadContextTruncated,
      loadedAt
    ),
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
      retainedBytes: retainedBytesWithTail(bounded.messages, bounded.threadContext, latestTail),
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
  const bounded = boundMessageWindow(messages, {
    maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
    maxBytes: visibleByteBudget(window.latestTail),
    retain: direction === "older" ? "oldest" : "newest",
    threadContext,
    existingGaps: {
      older: direction === "older" ? page.hasMoreBefore : window.context.hasMoreBefore,
      newer: direction === "newer" ? page.hasMoreAfter : window.context.hasMoreAfter,
    },
  });
  return {
    history: contextHistory(
      current,
      bounded.messages,
      bounded.threadContext,
      current.searchThreadContextTruncated || page.threadContextTruncated,
      loadedAt
    ),
    window: {
      ...window,
      context: {
        ...window.context,
        hasMoreBefore: bounded.gaps.older,
        hasMoreAfter: bounded.gaps.newer,
        loadingDirection: null,
      },
      retainedBytes: retainedBytesWithTail(
        bounded.messages,
        bounded.threadContext,
        window.latestTail
      ),
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
      retainedBytes: retainedBytesWithTail(
        history.messages,
        history.threadContext,
        window.latestTail
      ),
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
      retainedBytes: tail.retainedBytes,
    },
    outcome: "applied",
    evictedOlder: 0,
    evictedNewer: 0,
  };
};
