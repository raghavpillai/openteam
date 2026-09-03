import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "@openteam/contracts";
import type { LoadedChannelHistory } from "@openteam/product-core/history";
import {
  clearLoadedChannelSearchContext,
  compareEntitySequence,
  emptyLoadedChannelHistory,
  mergeLoadedChannelHistoryPage,
  sortedUniqueMessages,
} from "@openteam/product-core/history";
import {
  type BoundMessageWindowOptions,
  boundMessageWindow,
  boundMessageWindowAroundViewport,
  latestRefreshOverlap,
  type MessageViewportFillDirection,
  messageRetainedByteSize,
} from "@openteam/product-core/message-window";

export const MESSAGE_HISTORY_PAGE_SIZE = 100;
export const MESSAGE_HISTORY_MAX_MESSAGES = 500;
export const MESSAGE_HISTORY_MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const MIN_VISIBLE_WINDOW_BYTES = 64 * 1024;
const MAX_RETAINED_REBALANCE_PASSES = 12;

export type MessageHistoryDirection = "older" | "newer";

export interface MessageViewportRetention {
  fill: MessageViewportFillDirection;
  messageIds: ReadonlySet<string>;
}

export interface MessageContextWindowState {
  targetMessageId: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadingDirection: MessageHistoryDirection | null;
  retentionEdge: "oldest" | "newest";
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

const uniqueRetainedMessages = (
  ...lanes: ReadonlyArray<readonly ChannelMessageView[]>
): Map<string, ChannelMessageView> => {
  const byId = new Map<string, ChannelMessageView>();
  for (const lane of lanes) for (const message of lane) byId.set(message.id, message);
  return byId;
};

const retainedStats = (...lanes: ReadonlyArray<readonly ChannelMessageView[]>) => {
  const byId = uniqueRetainedMessages(...lanes);
  let total = 0;
  for (const message of byId.values()) total += messageRetainedByteSize(message);
  return { messages: byId.size, bytes: total };
};

const uniqueRetainedBytes = (...lanes: ReadonlyArray<readonly ChannelMessageView[]>): number =>
  retainedStats(...lanes).bytes;

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

type RetainedLaneOptions = Omit<BoundMessageWindowOptions, "maxBytes"> & {
  viewportFill?: MessageViewportFillDirection;
  viewportMessageIds?: ReadonlySet<string>;
};

const retainedStatsFit = ({ messages, bytes }: ReturnType<typeof retainedStats>): boolean =>
  messages <= MESSAGE_HISTORY_MAX_MESSAGES && bytes <= MESSAGE_HISTORY_MAX_RETAINED_BYTES;

interface RetainedLaneFit {
  bounded: ReturnType<typeof boundMessageWindow>;
  fits: boolean;
}

/**
 * Bound one lane against every other retained lane. Count and bytes are both
 * measured over the exact unique-ID union, so overlap with a cached tail is
 * free. A protected span or one indivisible oversized row can still return a
 * non-fitting result; the state-level rebalancer then evicts lower-priority
 * lanes before accepting that documented soft excess.
 */
const boundRetainedLane = (
  messages: readonly ChannelMessageView[],
  options: RetainedLaneOptions,
  otherLanes: ReadonlyArray<readonly ChannelMessageView[]>
): RetainedLaneFit => {
  const { viewportFill, viewportMessageIds, ...edgeOptions } = options;
  const applyBound = (maxMessages: number, maxBytes: number) => {
    if (!viewportMessageIds || viewportMessageIds.size === 0) {
      return boundMessageWindow(messages, { ...edgeOptions, maxBytes, maxMessages });
    }
    const { retain, ...viewportOptions } = edgeOptions;
    return boundMessageWindowAroundViewport(messages, {
      ...viewportOptions,
      fill: viewportFill ?? (retain === "oldest" ? "older-first" : "newer-first"),
      maxBytes,
      maxMessages,
      viewportMessageIds,
    });
  };
  let maxMessages = Math.min(MESSAGE_HISTORY_MAX_MESSAGES, Math.max(1, messages.length));
  let maxBytes = MESSAGE_HISTORY_MAX_RETAINED_BYTES;
  let bounded = applyBound(maxMessages, maxBytes);
  for (let attempt = 0; attempt < MAX_RETAINED_REBALANCE_PASSES; attempt += 1) {
    const total = retainedStats(bounded.messages, bounded.threadContext, ...otherLanes);
    if (retainedStatsFit(total)) return { bounded, fits: true };
    const excessMessages = Math.max(0, total.messages - MESSAGE_HISTORY_MAX_MESSAGES);
    const excessBytes = Math.max(0, total.bytes - MESSAGE_HISTORY_MAX_RETAINED_BYTES);
    const nextMaxMessages = Math.min(
      maxMessages,
      Math.max(1, bounded.messages.length - Math.max(excessMessages, excessMessages > 0 ? 1 : 0))
    );
    const nextMaxBytes = Math.min(
      maxBytes,
      Math.max(1, bounded.retainedBytes - Math.max(excessBytes, excessBytes > 0 ? 1 : 0))
    );
    if (nextMaxMessages >= maxMessages && nextMaxBytes >= maxBytes) {
      return { bounded, fits: false };
    }
    maxMessages = Math.min(maxMessages, nextMaxMessages);
    maxBytes = nextMaxBytes;
    bounded = applyBound(maxMessages, maxBytes);
  }
  // A pathological overlap layout can make marginal progress irregular. One
  // conservative pass treats every retained byte/ID as new; it can over-trim,
  // but it cannot violate either hard union ceiling.
  const other = retainedStats(...otherLanes);
  const conservativeMaxMessages = Math.max(1, MESSAGE_HISTORY_MAX_MESSAGES - other.messages);
  const conservativeMaxBytes = Math.max(1, MESSAGE_HISTORY_MAX_RETAINED_BYTES - other.bytes);
  bounded = applyBound(
    Math.min(maxMessages, conservativeMaxMessages),
    Math.min(maxBytes, conservativeMaxBytes)
  );
  return {
    bounded,
    fits: retainedStatsFit(retainedStats(bounded.messages, bounded.threadContext, ...otherLanes)),
  };
};

const boundedHistory = (
  history: LoadedChannelHistory,
  retain: "oldest" | "newest",
  maxBytes: number,
  gaps: { older: boolean; newer: boolean },
  protectedIds?: ReadonlySet<string>,
  viewport?: MessageViewportRetention
) => {
  const options = {
    maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
    maxBytes,
    threadContext: history.threadContext,
    existingGaps: gaps,
  };
  const viewportIntersectsHistory =
    viewport && history.messages.some((message) => viewport.messageIds.has(message.id));
  return viewportIntersectsHistory
    ? boundMessageWindowAroundViewport(history.messages, {
        ...options,
        fill: viewport.fill,
        viewportMessageIds: viewport.messageIds,
      })
    : boundMessageWindow(history.messages, { ...options, retain, protectedIds });
};

const boundedHistoryAgainst = (
  history: LoadedChannelHistory,
  retain: "oldest" | "newest",
  gaps: { older: boolean; newer: boolean },
  otherLanes: ReadonlyArray<readonly ChannelMessageView[]>,
  protectedIds?: ReadonlySet<string>,
  viewport?: MessageViewportRetention
) =>
  boundRetainedLane(
    history.messages,
    {
      maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
      retain,
      protectedIds,
      viewportFill: viewport?.fill,
      viewportMessageIds: viewport?.messageIds,
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

const emptyBoundedLane = (
  messages: readonly ChannelMessageView[],
  retain: "oldest" | "newest",
  gaps: { older: boolean; newer: boolean }
): ReturnType<typeof boundMessageWindow> => ({
  messages: [],
  threadContext: [],
  primaryBytes: 0,
  contextBytes: 0,
  retainedBytes: 0,
  eviction: { older: null, newer: null },
  gaps: {
    older: gaps.older || (messages.length > 0 && retain === "newest"),
    newer: gaps.newer || (messages.length > 0 && retain === "oldest"),
  },
  softExcess: { messages: 0, bytes: 0, protected: false, oversized: false },
  missingProtectedIds: [],
  missingAncestorIds: [],
});

const primaryRetentionEdge = (window: ChannelMessageWindowState): "oldest" | "newest" =>
  window.primaryHasNewerGap ? "oldest" : "newest";

const latestTailFit = (
  tail: MessageLatestTail | null,
  otherLanes: ReadonlyArray<readonly ChannelMessageView[]>,
  protectedMessageId?: string
): { tail: MessageLatestTail | null; fits: boolean } => {
  if (!tail) return { tail: null, fits: retainedStatsFit(retainedStats(...otherLanes)) };
  const fit = boundRetainedLane(
    tail.messages,
    {
      maxMessages: MESSAGE_HISTORY_PAGE_SIZE,
      retain: "newest",
      protectedIds: protectedMessageId ? new Set([protectedMessageId]) : undefined,
      threadContext: [...tail.messages, ...tail.threadContext],
      existingGaps: { older: tail.hasMore },
    },
    otherLanes
  );
  if (!fit.fits) return { tail, fits: false };
  return {
    tail: {
      ...tail,
      messages: fit.bounded.messages,
      threadContext: fit.bounded.threadContext,
      beforeSequence: fit.bounded.messages[0]?.sequence ?? null,
      hasMore: fit.bounded.gaps.older,
      retainedBytes: fit.bounded.retainedBytes,
    },
    fits: true,
  };
};

const genuineSoftExcess = (bounded: ReturnType<typeof boundMessageWindow>): boolean =>
  bounded.softExcess.oversized ||
  bounded.softExcess.protected ||
  (bounded.messages.length === 1 && bounded.threadContext.length > 0);

const viewportRetentionForLanes = (
  viewport: MessageViewportRetention | undefined,
  ...lanes: ReadonlyArray<readonly ChannelMessageView[]>
): MessageViewportRetention | undefined => {
  if (!viewport || viewport.messageIds.size === 0) return undefined;
  const available = new Set<string>();
  for (const lane of lanes) for (const message of lane) available.add(message.id);
  const messageIds = new Set([...viewport.messageIds].filter((id) => available.has(id)));
  return messageIds.size > 0 ? { fill: viewport.fill, messageIds } : undefined;
};

const retainsRequestedPageProgress = (
  retained: readonly ChannelMessageView[],
  requested: readonly ChannelMessageView[],
  previous: readonly ChannelMessageView[]
): boolean => {
  const requestedIds = new Set(requested.map((message) => message.id));
  for (const message of previous) requestedIds.delete(message.id);
  return requestedIds.size === 0 || retained.some((message) => requestedIds.has(message.id));
};

const rebalanceRetainedState = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState,
  protectedMessageId?: string,
  viewport?: MessageViewportRetention
): { history: LoadedChannelHistory; window: ChannelMessageWindowState } => {
  const originalPrimary = history.messages;
  const originalPrimaryThread = history.threadContext;
  let nextHistory = history;
  let latestTail = window.latestTail;

  if (window.context) {
    const contextMessages = history.searchContext;
    const contextThread = history.searchThreadContext;
    const primaryRetain = primaryRetentionEdge(window);
    const primaryFit = boundedHistoryAgainst(
      history,
      primaryRetain,
      { older: history.hasMore, newer: window.primaryHasNewerGap },
      [contextMessages, contextThread, ...latestTailLanes(latestTail)],
      protectedMessageId && history.messages.some(({ id }) => id === protectedMessageId)
        ? new Set([protectedMessageId])
        : undefined,
      undefined
    );
    nextHistory = withBoundedPrimary(
      history,
      primaryFit.fits
        ? primaryFit.bounded
        : emptyBoundedLane(history.messages, primaryRetain, {
            older: history.hasMore,
            newer: window.primaryHasNewerGap,
          })
    );

    const contextOtherLanes = [
      nextHistory.messages,
      nextHistory.threadContext,
      ...latestTailLanes(latestTail),
    ];
    const contextViewport = viewportRetentionForLanes(viewport, contextMessages, contextThread);
    let contextFit = boundRetainedLane(
      contextMessages,
      {
        maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
        retain: window.context.retentionEdge,
        protectedIds:
          protectedMessageId &&
          [...contextMessages, ...contextThread].some(({ id }) => id === protectedMessageId)
            ? new Set([protectedMessageId])
            : undefined,
        threadContext: contextThread,
        existingGaps: {
          older: window.context.hasMoreBefore,
          newer: window.context.hasMoreAfter,
        },
        viewportFill: contextViewport?.fill,
        viewportMessageIds: contextViewport?.messageIds,
      },
      contextOtherLanes
    );

    if (!contextFit.fits) {
      // The hidden primary was already the first eviction target. If a protected
      // context span still cannot coexist with the cached tail, shrink the tail
      // before accepting a genuine context-only soft excess.
      nextHistory = withBoundedPrimary(
        history,
        emptyBoundedLane(history.messages, primaryRetain, {
          older: history.hasMore,
          newer: window.primaryHasNewerGap,
        })
      );
      const contextAlone = boundRetainedLane(
        contextMessages,
        {
          maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
          retain: window.context.retentionEdge,
          protectedIds:
            protectedMessageId &&
            [...contextMessages, ...contextThread].some(({ id }) => id === protectedMessageId)
              ? new Set([protectedMessageId])
              : undefined,
          threadContext: contextThread,
          existingGaps: {
            older: window.context.hasMoreBefore,
            newer: window.context.hasMoreAfter,
          },
          viewportFill: contextViewport?.fill,
          viewportMessageIds: contextViewport?.messageIds,
        },
        []
      );
      const fittedTail = latestTailFit(latestTail, [
        contextAlone.bounded.messages,
        contextAlone.bounded.threadContext,
      ]);
      latestTail = fittedTail.fits ? fittedTail.tail : null;
      contextFit = boundRetainedLane(
        contextMessages,
        {
          maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
          retain: window.context.retentionEdge,
          protectedIds:
            protectedMessageId &&
            [...contextMessages, ...contextThread].some(({ id }) => id === protectedMessageId)
              ? new Set([protectedMessageId])
              : undefined,
          threadContext: contextThread,
          existingGaps: {
            older: window.context.hasMoreBefore,
            newer: window.context.hasMoreAfter,
          },
          viewportFill: contextViewport?.fill,
          viewportMessageIds: contextViewport?.messageIds,
        },
        latestTailLanes(latestTail)
      );
      if (!contextFit.fits) {
        latestTail = null;
        contextFit = contextAlone;
      }
    }

    const finalContext = contextFit.bounded;
    nextHistory = {
      ...nextHistory,
      searchContext: finalContext.messages,
      searchThreadContext: finalContext.threadContext,
      loading: false,
    };
    const context = {
      ...window.context,
      targetMessageId: retainedContextTargetId(window.context.targetMessageId, contextMessages, [
        ...finalContext.threadContext,
        ...finalContext.messages,
      ]),
      hasMoreBefore: finalContext.gaps.older,
      hasMoreAfter: finalContext.gaps.newer,
    };

    // Refill any exact capacity left after fitting the active context and tail.
    const refill = boundRetainedLane(
      originalPrimary,
      {
        maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
        retain: primaryRetain,
        threadContext: originalPrimaryThread,
        existingGaps: { older: history.hasMore, newer: window.primaryHasNewerGap },
      },
      [nextHistory.searchContext, nextHistory.searchThreadContext, ...latestTailLanes(latestTail)]
    );
    if (refill.fits) nextHistory = withBoundedPrimary(nextHistory, refill.bounded);

    const union = retainedStats(
      nextHistory.messages,
      nextHistory.threadContext,
      nextHistory.searchContext,
      nextHistory.searchThreadContext,
      ...latestTailLanes(latestTail)
    );
    if (!retainedStatsFit(union) && !genuineSoftExcess(finalContext)) {
      // A non-protected overage is never allowed. This fallback is intentionally
      // conservative and should only be reachable for pathological ancestry.
      nextHistory = withBoundedPrimary(
        nextHistory,
        emptyBoundedLane(nextHistory.messages, primaryRetain, {
          older: nextHistory.hasMore,
          newer: window.primaryHasNewerGap,
        })
      );
      latestTail = null;
    }
    return {
      history: nextHistory,
      window: {
        ...window,
        context,
        latestTail,
        retainedBytes: retainedStateBytes(nextHistory, latestTail),
      },
    };
  }

  const primaryRetain = primaryRetentionEdge(window);
  const primaryViewport = viewportRetentionForLanes(
    viewport,
    history.messages,
    history.threadContext
  );
  let primaryFit = boundedHistoryAgainst(
    history,
    primaryRetain,
    { older: history.hasMore, newer: window.primaryHasNewerGap },
    latestTailLanes(latestTail),
    protectedMessageId &&
      [...history.messages, ...history.threadContext].some(({ id }) => id === protectedMessageId)
      ? new Set([protectedMessageId])
      : undefined,
    primaryViewport
  );
  if (!primaryFit.fits) {
    const primaryAlone = boundedHistoryAgainst(
      history,
      primaryRetain,
      { older: history.hasMore, newer: window.primaryHasNewerGap },
      [],
      protectedMessageId ? new Set([protectedMessageId]) : undefined,
      primaryViewport
    );
    const fittedTail = latestTailFit(latestTail, [
      primaryAlone.bounded.messages,
      primaryAlone.bounded.threadContext,
    ]);
    latestTail = fittedTail.fits ? fittedTail.tail : null;
    primaryFit = boundedHistoryAgainst(
      history,
      primaryRetain,
      { older: history.hasMore, newer: window.primaryHasNewerGap },
      latestTailLanes(latestTail),
      protectedMessageId ? new Set([protectedMessageId]) : undefined,
      primaryViewport
    );
    if (!primaryFit.fits) {
      latestTail = null;
      primaryFit = primaryAlone;
    }
  }
  const boundedPrimary = primaryFit.bounded;
  nextHistory = withBoundedPrimary(history, boundedPrimary);
  const union = retainedStats(
    nextHistory.messages,
    nextHistory.threadContext,
    ...latestTailLanes(latestTail)
  );
  if (!retainedStatsFit(union) && !genuineSoftExcess(boundedPrimary)) {
    nextHistory = withBoundedPrimary(
      history,
      emptyBoundedLane(history.messages, primaryRetain, {
        older: history.hasMore,
        newer: window.primaryHasNewerGap,
      })
    );
    latestTail = null;
  }
  return {
    history: nextHistory,
    window: {
      ...window,
      primaryHasNewerGap: boundedPrimary.gaps.newer,
      latestTail,
      retainedBytes: retainedStateBytes(nextHistory, latestTail),
    },
  };
};

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
  context: MessageContextWindowState | null = window.context,
  viewport?: MessageViewportRetention
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
    nextHistory = withBoundedPrimary(nextHistory, boundedPrimary.bounded);
    primaryHasNewerGap = boundedPrimary.bounded.gaps.newer;
    evictedOlder += boundedPrimary.bounded.eviction.older?.count ?? 0;
    evictedNewer += boundedPrimary.bounded.eviction.newer?.count ?? 0;

    const contextMessages = sortedUniqueMessages(history.searchContext).sort(compareEntitySequence);
    const contextViewport = viewportRetentionForLanes(
      viewport,
      contextMessages,
      history.searchThreadContext
    );
    const bounded = boundRetainedLane(
      contextMessages,
      {
        maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
        retain: nextContext.retentionEdge,
        threadContext: history.searchThreadContext,
        existingGaps: {
          older: nextContext.hasMoreBefore,
          newer: nextContext.hasMoreAfter,
        },
        viewportFill: contextViewport?.fill,
        viewportMessageIds: contextViewport?.messageIds,
      },
      [nextHistory.messages, nextHistory.threadContext, ...latestTailLanes(latestTail)]
    );
    nextHistory = contextHistory(
      nextHistory,
      bounded.bounded.messages,
      bounded.bounded.threadContext,
      history.searchThreadContextTruncated,
      loadedAt
    );
    boundedContext = {
      ...nextContext,
      targetMessageId: retainedContextTargetId(nextContext.targetMessageId, contextMessages, [
        ...bounded.bounded.threadContext,
        ...bounded.bounded.messages,
      ]),
      hasMoreBefore: bounded.bounded.gaps.older,
      hasMoreAfter: bounded.bounded.gaps.newer,
      loadingDirection: null,
    };
    evictedOlder += bounded.bounded.eviction.older?.count ?? 0;
    evictedNewer += bounded.bounded.eviction.newer?.count ?? 0;
  } else {
    const bounded = boundedHistoryAgainst(
      nextHistory,
      "oldest",
      { older: history.hasMore, newer: primaryHasNewerGap },
      [history.searchContext, history.searchThreadContext, ...latestTailLanes(latestTail)],
      undefined,
      viewportRetentionForLanes(viewport, nextHistory.messages, nextHistory.threadContext)
    );
    nextHistory = withBoundedPrimary(nextHistory, bounded.bounded);
    primaryHasNewerGap = bounded.bounded.gaps.newer;
    evictedOlder += bounded.bounded.eviction.older?.count ?? 0;
    evictedNewer += bounded.bounded.eviction.newer?.count ?? 0;
  }

  const rebalanced = rebalanceRetainedState(
    nextHistory,
    {
      ...window,
      primaryHasNewerGap,
      context: boundedContext,
      latestTail,
      retainedBytes: retainedStateBytes(nextHistory, latestTail),
    },
    undefined,
    viewport
  );
  return {
    history: rebalanced.history,
    window: rebalanced.window,
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
  viewport,
}: {
  current: LoadedChannelHistory | undefined;
  window: ChannelMessageWindowState | undefined;
  page: ChannelHistoryPage;
  mode: "replace" | "refresh" | "older";
  atBottom: boolean;
  loadedAt?: number;
  viewport?: MessageViewportRetention;
}): MessageWindowTransition => {
  const base = current ?? emptyLoadedChannelHistory();
  const state = window ?? emptyChannelMessageWindow();
  const pagingViewport =
    atBottom && mode !== "older"
      ? undefined
      : mode === "older" && viewport
        ? { ...viewport, fill: "older-first" as const }
        : viewport;

  if (mode === "replace" || base.loadedAt === 0) {
    const merged = mergeLoadedChannelHistoryPage(base, page, "replace", loadedAt);
    const bounded = boundedHistory(
      merged,
      "newest",
      MESSAGE_HISTORY_MAX_RETAINED_BYTES,
      {
        older: page.hasMore,
        newer: false,
      },
      undefined,
      pagingViewport
    );
    const history = clearLoadedChannelSearchContext(withBoundedPrimary(merged, bounded));
    const rebalanced = rebalanceRetainedState(
      history,
      {
        generation: state.generation + 1,
        primaryHasNewerGap: false,
        context: null,
        latestTail: null,
        retainedBytes: retainedStateBytes(history, null),
      },
      undefined,
      pagingViewport
    );
    return {
      history: rebalanced.history,
      window: rebalanced.window,
      outcome: "applied",
      evictedOlder: bounded.eviction.older?.count ?? 0,
      evictedNewer: bounded.eviction.newer?.count ?? 0,
    };
  }

  if (mode === "older") {
    const merged = mergeLoadedChannelHistoryPage(base, page, "older", loadedAt);
    let retentionViewport = pagingViewport;
    let firstPass = boundedHistory(
      merged,
      "oldest",
      MESSAGE_HISTORY_MAX_RETAINED_BYTES,
      {
        older: page.hasMore,
        newer: state.primaryHasNewerGap,
      },
      undefined,
      retentionViewport
    );
    // A viewport report can be stale when an explicit/automatic edge load wins
    // the race with the next virtual-list report. Never let that pivot discard
    // the requested page entirely: doing so leaves beforeSequence unchanged and
    // repeats the same request forever. Prefer the live anchor when it fits;
    // otherwise the user's explicit older-page intent determines the edge.
    if (!retainsRequestedPageProgress(firstPass.messages, page.messages, base.messages)) {
      retentionViewport = undefined;
      firstPass = boundedHistory(merged, "oldest", MESSAGE_HISTORY_MAX_RETAINED_BYTES, {
        older: page.hasMore,
        newer: state.primaryHasNewerGap,
      });
    }
    const needsTail = state.primaryHasNewerGap || firstPass.eviction.newer !== null;
    const latestTail = needsTail ? (state.latestTail ?? latestTailFromHistory(base)) : null;
    let bounded = boundedHistoryAgainst(
      merged,
      "oldest",
      {
        older: page.hasMore,
        newer: state.primaryHasNewerGap,
      },
      [merged.searchContext, merged.searchThreadContext, ...latestTailLanes(latestTail)],
      undefined,
      retentionViewport
    );
    if (!retainsRequestedPageProgress(bounded.bounded.messages, page.messages, base.messages)) {
      retentionViewport = undefined;
      bounded = boundedHistoryAgainst(
        merged,
        "oldest",
        {
          older: page.hasMore,
          newer: state.primaryHasNewerGap,
        },
        [merged.searchContext, merged.searchThreadContext, ...latestTailLanes(latestTail)]
      );
    }
    const history = withBoundedPrimary(merged, bounded.bounded);
    const rebalanced = rebalanceRetainedState(
      history,
      {
        ...state,
        primaryHasNewerGap: bounded.bounded.gaps.newer,
        latestTail,
        retainedBytes: retainedStateBytes(history, latestTail),
      },
      undefined,
      retentionViewport
    );
    return {
      history: rebalanced.history,
      window: rebalanced.window,
      outcome: "applied",
      evictedOlder: bounded.bounded.eviction.older?.count ?? 0,
      evictedNewer: bounded.bounded.eviction.newer?.count ?? 0,
    };
  }

  if (state.context || state.primaryHasNewerGap) {
    return preservedHistory(base, state, page, loadedAt, state.context, viewport);
  }

  const overlap = latestRefreshOverlap(base.messages, page.messages);
  if (overlap.requiresReset && !atBottom) {
    return preservedHistory(base, state, page, loadedAt, state.context, viewport);
  }

  const merged = mergeLoadedChannelHistoryPage(
    base,
    page,
    overlap.requiresReset ? "replace" : "refresh",
    loadedAt
  );
  const bounded = boundedHistory(
    merged,
    "newest",
    MESSAGE_HISTORY_MAX_RETAINED_BYTES,
    {
      older: page.hasMore || base.hasMore,
      newer: false,
    },
    undefined,
    viewport
  );
  if ((bounded.eviction.older || bounded.eviction.newer) && !atBottom) {
    return preservedHistory(base, state, page, loadedAt, state.context, viewport);
  }

  const history = withBoundedPrimary(merged, bounded);
  const rebalanced = rebalanceRetainedState(
    history,
    {
      ...state,
      primaryHasNewerGap: false,
      latestTail: null,
      retainedBytes: retainedStateBytes(history, null),
    },
    undefined,
    viewport
  );
  return {
    history: rebalanced.history,
    window: rebalanced.window,
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
    latestTailLanes(latestTail)
  );
  const history = contextHistory(
    current,
    bounded.bounded.messages,
    bounded.bounded.threadContext,
    context.threadContextTruncated,
    loadedAt
  );
  const rebalanced = rebalanceRetainedState(
    history,
    {
      ...window,
      generation: window.generation + 1,
      context: {
        targetMessageId: context.targetMessageId,
        hasMoreBefore: bounded.bounded.gaps.older,
        hasMoreAfter: bounded.bounded.gaps.newer,
        loadingDirection: null,
        retentionEdge: "newest",
      },
      latestTail,
      retainedBytes: retainedStateBytes(history, latestTail),
    },
    context.targetMessageId
  );
  return {
    history: rebalanced.history,
    window: rebalanced.window,
    outcome: "applied",
    evictedOlder: bounded.bounded.eviction.older?.count ?? 0,
    evictedNewer: bounded.bounded.eviction.newer?.count ?? 0,
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
  viewport,
}: {
  current: LoadedChannelHistory;
  window: ChannelMessageWindowState;
  page: ChannelMessageContextView;
  direction: MessageHistoryDirection;
  loadedAt?: number;
  viewport?: MessageViewportRetention;
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
  const pagingViewport = viewport
    ? {
        ...viewport,
        fill: direction === "older" ? ("older-first" as const) : ("newer-first" as const),
      }
    : undefined;
  const retain = direction === "older" ? ("oldest" as const) : ("newest" as const);
  const gaps = {
    older: direction === "older" ? page.hasMoreBefore : window.context.hasMoreBefore,
    newer: direction === "newer" ? page.hasMoreAfter : window.context.hasMoreAfter,
  };
  let retentionViewport = pagingViewport;
  const contextViewport = viewportRetentionForLanes(retentionViewport, messages, threadContext);
  let bounded = boundRetainedLane(
    messages,
    {
      maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
      retain,
      threadContext,
      existingGaps: gaps,
      viewportFill: contextViewport?.fill,
      viewportMessageIds: contextViewport?.messageIds,
    },
    latestTailLanes(window.latestTail)
  );
  if (
    !retainsRequestedPageProgress(bounded.bounded.messages, page.messages, current.searchContext)
  ) {
    retentionViewport = undefined;
    bounded = boundRetainedLane(
      messages,
      {
        maxMessages: MESSAGE_HISTORY_MAX_MESSAGES,
        retain,
        threadContext,
        existingGaps: gaps,
      },
      latestTailLanes(window.latestTail)
    );
  }
  const history = contextHistory(
    current,
    bounded.bounded.messages,
    bounded.bounded.threadContext,
    current.searchThreadContextTruncated || page.threadContextTruncated,
    loadedAt
  );
  const rebalanced = rebalanceRetainedState(
    history,
    {
      ...window,
      context: {
        ...window.context,
        targetMessageId: retainedContextTargetId(window.context.targetMessageId, messages, [
          ...bounded.bounded.threadContext,
          ...bounded.bounded.messages,
        ]),
        hasMoreBefore: bounded.bounded.gaps.older,
        hasMoreAfter: bounded.bounded.gaps.newer,
        loadingDirection: null,
        retentionEdge: direction === "older" ? "oldest" : "newest",
      },
      retainedBytes: retainedStateBytes(history, window.latestTail),
    },
    undefined,
    retentionViewport
  );
  return {
    history: rebalanced.history,
    window: rebalanced.window,
    outcome: "applied",
    evictedOlder: bounded.bounded.eviction.older?.count ?? 0,
    evictedNewer: bounded.bounded.eviction.newer?.count ?? 0,
  };
};

export const clearMessageContext = (
  current: LoadedChannelHistory,
  window: ChannelMessageWindowState
): MessageWindowTransition => {
  const history = clearLoadedChannelSearchContext(current);
  const rebalanced = rebalanceRetainedState(history, {
    ...window,
    generation: window.generation + 1,
    context: null,
    retainedBytes: retainedStateBytes(history, window.latestTail),
  });
  return {
    history: rebalanced.history,
    window: rebalanced.window,
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
  const rebalanced = rebalanceRetainedState(history, {
    generation: window.generation + 1,
    primaryHasNewerGap: false,
    context: null,
    latestTail: null,
    retainedBytes: retainedStateBytes(history, null),
  });
  return {
    history: rebalanced.history,
    window: rebalanced.window,
    outcome: "applied",
    evictedOlder: 0,
    evictedNewer: 0,
  };
};

export const retainedMessageWindowStats = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState
): { messages: number; bytes: number } =>
  retainedStats(
    history.messages,
    history.threadContext,
    history.searchContext,
    history.searchThreadContext,
    ...latestTailLanes(window.latestTail)
  );

const replaceRetainedMessage = (
  values: ChannelMessageView[],
  message: ChannelMessageView
): { changed: boolean; values: ChannelMessageView[] } => {
  let changed = false;
  const next = values.map((candidate) => {
    if (candidate.id !== message.id) return candidate;
    changed = true;
    return message;
  });
  return { changed, values: changed ? next : values };
};

/**
 * Reconcile an authoritative message across every retained copy, then run the
 * same global cap policy used by page transitions. This deliberately avoids a
 * byte delta: one ID can overlap primary, context, and tail lanes, and payload
 * growth can require a real opposite-edge eviction rather than only a counter
 * update.
 */
export const patchRetainedMessageWindow = (
  current: LoadedChannelHistory,
  window: ChannelMessageWindowState,
  message: ChannelMessageView,
  viewport?: MessageViewportRetention
): MessageWindowTransition | null => {
  const primary = replaceRetainedMessage(current.messages, message);
  const primaryThread = replaceRetainedMessage(current.threadContext, message);
  const context = replaceRetainedMessage(current.searchContext, message);
  const contextThread = replaceRetainedMessage(current.searchThreadContext, message);
  const tailMessages = window.latestTail
    ? replaceRetainedMessage(window.latestTail.messages, message)
    : null;
  const tailThread = window.latestTail
    ? replaceRetainedMessage(window.latestTail.threadContext, message)
    : null;
  const changed =
    primary.changed ||
    primaryThread.changed ||
    context.changed ||
    contextThread.changed ||
    tailMessages?.changed === true ||
    tailThread?.changed === true;
  if (!changed) return null;

  const history: LoadedChannelHistory = {
    ...current,
    messages: primary.values,
    threadContext: primaryThread.values,
    searchContext: context.values,
    searchThreadContext: contextThread.values,
    loading: false,
  };
  const latestTail =
    window.latestTail && tailMessages && tailThread
      ? {
          ...window.latestTail,
          messages: tailMessages.values,
          threadContext: tailThread.values,
          retainedBytes: uniqueRetainedBytes(tailMessages.values, tailThread.values),
        }
      : window.latestTail;
  const provisionalWindow: ChannelMessageWindowState = {
    ...window,
    generation: window.context ? window.generation + 1 : window.generation,
    context: window.context ? { ...window.context, loadingDirection: null } : window.context,
    latestTail,
    retainedBytes: retainedStateBytes(history, latestTail),
  };
  // A reported viewport already protects the patched row when it is visible.
  // Do not otherwise protect an off-screen patch by ID: edge-to-ID protection
  // would retain every intervening row and could turn one large middle update
  // into an unbounded contiguous soft excess. Inactive/off-screen rows may be
  // evicted and fetched again; visible rows keep their pivot and exact object.
  const rebalanced = rebalanceRetainedState(history, provisionalWindow, undefined, viewport);
  return {
    history: rebalanced.history,
    window: rebalanced.window,
    outcome: "applied",
    evictedOlder: 0,
    evictedNewer: 0,
  };
};
