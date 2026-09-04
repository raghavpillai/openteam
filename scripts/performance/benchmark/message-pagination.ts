import { mkdir, writeFile } from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname, resolve } from "node:path";
import {
  applyPrimaryHistoryPage,
  type ChannelMessageWindowState,
  emptyChannelMessageWindow,
  enterMessageContext,
  expandMessageContext,
  MESSAGE_HISTORY_MAX_MESSAGES,
  MESSAGE_HISTORY_MAX_RETAINED_BYTES,
  MESSAGE_HISTORY_PAGE_SIZE,
  type MessageWindowTransition,
  resetToLatestTail,
  visibleChannelHistoryMessages,
} from "../../../apps/desktop/src/renderer/lib/message-history-window";
import {
  computeVirtualLayout,
  computeVirtualRangeFromLayout,
} from "../../../apps/desktop/src/renderer/lib/virtual-window";
import type {
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
} from "../../../packages/contracts/src/index";
import {
  compareEntitySequence,
  emptyLoadedChannelHistory,
  type LoadedChannelHistory,
  loadedChannelHistoryMessages,
  mergeLoadedChannelHistoryPage,
  mergeLoadedChannelMessageContext,
  sortedUniqueMessages,
} from "../../../packages/product-core/src/history";
import {
  channelMessageAddress,
  deriveThreads,
  isBranchedMessage,
  messageDisplayProjection,
  messageRenderKey,
} from "../../../packages/product-core/src/messages";

const PAGE_SIZE = MESSAGE_HISTORY_PAGE_SIZE;
const ROLLING_MESSAGE_LIMIT = MESSAGE_HISTORY_MAX_MESSAGES;
const ROLLING_PAGE_COUNT = Math.ceil(ROLLING_MESSAGE_LIMIT / PAGE_SIZE);
const CONTEXT_BEFORE = 50;
const CONTEXT_AFTER = 50;
const SEARCH_NEWER_DISTANCE = 300;
const DEFAULT_ITERATIONS = 7;
const DEFAULT_POINT_SAMPLES = 31;
const CHANNEL_ID = "pagination-benchmark-channel";
const FIXED_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const utf8 = new TextEncoder();

type PayloadProfile = "mixed" | "rich";
type StrategyId = "A_current_unbounded" | "B_bounded_older_only" | "C_search_bidirectional";
type Direction = "older" | "newer";

interface WorkloadDefinition {
  id: string;
  messageCount: number;
  payloadProfile: PayloadProfile;
  classification: "realistic" | "stress";
}

interface Distribution {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  samples: number;
}

interface TraversalRun {
  state: LoadedChannelHistory;
  window: ChannelMessageWindowState | null;
  initialMergeMs: number;
  olderMergeMs: number[];
  projectionMs: number[];
  totalMergeMs: number;
  totalProjectionMs: number;
  evictedOlder: number;
  evictedNewer: number;
  peakRetainedBytes: number;
  maxPrimaryMessages: number;
}

interface BenchmarkHistoryState {
  history: LoadedChannelHistory;
  window: ChannelMessageWindowState | null;
}

interface ContextExpansionStep {
  direction: Direction;
  page: ChannelMessageContextView;
}

const workloads: WorkloadDefinition[] = [
  {
    id: "recent-100-mixed",
    messageCount: 100,
    payloadProfile: "mixed",
    classification: "realistic",
  },
  {
    id: "long-1000-mixed",
    messageCount: 1_000,
    payloadProfile: "mixed",
    classification: "realistic",
  },
  {
    id: "long-1000-rich",
    messageCount: 1_000,
    payloadProfile: "rich",
    classification: "stress",
  },
  {
    id: "extreme-10000-mixed",
    messageCount: 10_000,
    payloadProfile: "mixed",
    classification: "stress",
  },
  {
    id: "extreme-10000-rich",
    messageCount: 10_000,
    payloadProfile: "rich",
    classification: "stress",
  },
];

const iterations = Math.max(
  1,
  Number.parseInt(process.env.OPENTEAM_PAGINATION_ITERATIONS ?? `${DEFAULT_ITERATIONS}`, 10) ||
    DEFAULT_ITERATIONS
);
const pointSamples = Math.max(
  5,
  Number.parseInt(
    process.env.OPENTEAM_PAGINATION_POINT_SAMPLES ?? `${DEFAULT_POINT_SAMPLES}`,
    10
  ) || DEFAULT_POINT_SAMPLES
);

let observableChecksum = 0;

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
};

const distribution = (values: readonly number[]): Distribution => ({
  minMs: round(values.length > 0 ? Math.min(...values) : 0),
  p50Ms: round(percentile(values, 0.5)),
  p95Ms: round(percentile(values, 0.95)),
  maxMs: round(values.length > 0 ? Math.max(...values) : 0),
  meanMs: round(
    values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0
  ),
  samples: values.length,
});

const byteLength = (value: unknown): number => utf8.encode(JSON.stringify(value)).byteLength;

const payloadByteLength = (message: ChannelMessageView): number =>
  utf8.encode(message.content).byteLength +
  utf8.encode(JSON.stringify(message.metadata)).byteLength;

const assetIdAt = (index: number): string => index.toString(16).padStart(64, "0").slice(-64);

const regularContent = (index: number): string =>
  `Message ${index + 1}: deterministic conversation text with a status update, one decision, ` +
  `and enough prose to represent a normal chat row. ${"context ".repeat((index % 5) + 2)}`;

const richContent = (index: number): string => {
  const line = `| ${index + 1} | worker-${index % 17} | completed | ${(index * 37) % 10_000} ms |`;
  const table = `${line}\n`.repeat(72);
  const code =
    `const event${index} = { channel: "${CHANNEL_ID}", sequence: ${index + 1} };\n`.repeat(44);
  return `# Diagnostic message ${index + 1}\n\n${table}\n\n\`\`\`ts\n${code}\`\`\`\n`;
};

const metadataAt = (index: number, profile: PayloadProfile): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {
    address: `t${index + 1}${index % 4 === 0 ? "u" : "a0"}`,
  };
  if (index > 0 && index % 23 === 0) {
    metadata.branched = true;
    metadata.replyTo = `message-${(index - 1).toString().padStart(6, "0")}`;
  }
  if (index % 11 === 0) {
    metadata.reactions = [
      { by: "bot-a", emoji: "👍" },
      { by: "bot-b", emoji: "🎉" },
      ...(index % 22 === 0 ? [{ by: "me", emoji: "👍" }] : []),
    ];
  }
  if (index % 19 === 0 || profile === "rich") {
    metadata.attachments = [
      {
        assetId: assetIdAt(index + 1),
        fileName: `trace-${index + 1}.json`,
        mimeType: "application/json",
        byteSize: 48_000 + index,
        kind: "file",
        alt: `Deterministic trace ${index + 1}`,
      },
      ...(profile === "rich"
        ? [
            {
              assetId: assetIdAt(index + 50_001),
              fileName: `chart-${index + 1}.png`,
              mimeType: "image/png",
              byteSize: 320_000 + index,
              kind: "image",
              width: 1_600,
              height: 900,
              alt: `Benchmark chart ${index + 1} ${"detail ".repeat(24)}`,
            },
          ]
        : []),
    ];
  }
  if (profile === "rich") {
    metadata.diagnostics = {
      labels: Array.from({ length: 18 }, (_, labelIndex) => `label-${index}-${labelIndex}`),
      trace: `span-${index}-`.repeat(64),
    };
  }
  return metadata;
};

const messageAt = (index: number, profile: PayloadProfile): ChannelMessageView => ({
  id: `message-${index.toString().padStart(6, "0")}`,
  clientId: index % 29 === 0 ? `client-${index}` : null,
  sequence: `${index + 1}`,
  channelId: CHANNEL_ID,
  sender: index % 4 === 0 ? "user" : "agent",
  senderBotId: index % 4 === 0 ? null : `bot-${index % 12}`,
  sourceRunId: index % 7 === 0 ? `run-${Math.floor(index / 7)}` : null,
  content: profile === "rich" || index % 37 === 0 ? richContent(index) : regularContent(index),
  metadata: metadataAt(index, profile),
  createdAt: new Date(FIXED_EPOCH_MS + index * 60_000).toISOString(),
});

const createMessages = (count: number, profile: PayloadProfile): ChannelMessageView[] =>
  Array.from({ length: count }, (_, index) => messageAt(index, profile));

const createHistoryPage = (
  messages: readonly ChannelMessageView[],
  hasMore: boolean
): ChannelHistoryPage => ({
  channelId: CHANNEL_ID,
  messages: [...messages],
  threadContext: [],
  threadContextTruncated: false,
  beforeSequence: messages[0]?.sequence ?? null,
  hasMore,
  revision: messages.at(-1)?.sequence ?? "0",
});

const createHistoryPages = (messages: readonly ChannelMessageView[]): ChannelHistoryPage[] => {
  const pages: ChannelHistoryPage[] = [];
  for (let end = messages.length; end > 0; end -= PAGE_SIZE) {
    const start = Math.max(0, end - PAGE_SIZE);
    pages.push(createHistoryPage(messages.slice(start, end), start > 0));
  }
  return pages;
};

const createContext = (
  messages: readonly ChannelMessageView[],
  targetIndex: number
): ChannelMessageContextView => {
  const start = Math.max(0, targetIndex - CONTEXT_BEFORE);
  const end = Math.min(messages.length, targetIndex + CONTEXT_AFTER + 1);
  const contextMessages = messages.slice(start, end);
  const target = messages[targetIndex];
  if (!target) throw new Error(`Missing context target ${targetIndex}`);
  return {
    channelId: CHANNEL_ID,
    targetMessageId: target.id,
    messages: contextMessages,
    threadContext: [],
    threadContextTruncated: false,
    beforeSequence: contextMessages[0]?.sequence ?? target.sequence,
    afterSequence: contextMessages.at(-1)?.sequence ?? target.sequence,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < messages.length,
    revision: messages.at(-1)?.sequence ?? "0",
  };
};

const createDirectionalContext = (
  messages: readonly ChannelMessageView[],
  anchorIndex: number,
  direction: Direction,
  limit = PAGE_SIZE
): ChannelMessageContextView | null => {
  const target = messages[anchorIndex];
  if (!target) return null;
  const start = direction === "older" ? Math.max(0, anchorIndex - limit) : anchorIndex;
  const end =
    direction === "older" ? anchorIndex + 1 : Math.min(messages.length, anchorIndex + limit + 1);
  const contextMessages = messages.slice(start, end);
  if (contextMessages.length <= 1) return null;
  return {
    channelId: CHANNEL_ID,
    targetMessageId: target.id,
    messages: contextMessages,
    threadContext: [],
    threadContextTruncated: false,
    beforeSequence: contextMessages[0]?.sequence ?? target.sequence,
    afterSequence: contextMessages.at(-1)?.sequence ?? target.sequence,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < messages.length,
    revision: messages.at(-1)?.sequence ?? "0",
  };
};

const boundedStrategy = (strategy: StrategyId): boolean => strategy !== "A_current_unbounded";

const transitionChecksum = (transition: MessageWindowTransition): number =>
  transition.history.messages.length * 17 +
  transition.history.searchContext.length * 31 +
  transition.window.retainedBytes +
  transition.evictedOlder * 43 +
  transition.evictedNewer * 47 +
  (transition.window.primaryHasNewerGap ? 53 : 0);

/**
 * Mirrors the O(n) / O(n log n) renderer work that changes with retained history size:
 * history lane normalization, visible-record sorting, lookup maps, thread derivation,
 * timeline sorting, full virtual-layout construction, and projection of mounted rows.
 * It intentionally excludes React reconciliation, Markdown parsing, DOM measurement, and paint.
 */
const projectHistoryForRenderer = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState | null = null
): number => {
  const messages = window
    ? visibleChannelHistoryMessages(history, window)
    : loadedChannelHistoryMessages(history);
  const knownIds = new Set(messages.map((message) => message.id));
  const visibleRecords = messages
    .map((message) => ({
      renderKey: messageRenderKey(message),
      message,
    }))
    .sort(
      (left, right) =>
        new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime() ||
        left.renderKey.localeCompare(right.renderKey)
    );
  const messagesById = new Map(visibleRecords.map(({ message }) => [message.id, message] as const));
  const messagesByAddress = new Map(
    visibleRecords.map(({ message }) => [channelMessageAddress(message), message] as const)
  );
  const threads = deriveThreads(visibleRecords.map(({ message }) => message));
  const mainRecords = visibleRecords.filter(
    ({ message }) => !isBranchedMessage(message) || threads.has(message.id)
  );
  const timeline = mainRecords
    .map(({ message, renderKey }) => ({
      type: "message" as const,
      id: renderKey,
      createdAt: message.createdAt,
      message,
    }))
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id)
    );
  const layout = computeVirtualLayout(timeline.length, () => 72);
  const range = computeVirtualRangeFromLayout({
    ...layout,
    scrollOffset: Math.max(0, layout.totalSize - 900),
    viewportSize: 900,
    overscan: 900,
    maxItems: 80,
  });
  let projectedContentBytes = 0;
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const entry = timeline[index];
    if (!entry) continue;
    const projection = messageDisplayProjection(entry.message);
    projectedContentBytes += utf8.encode(projection.displayContent).byteLength;
  }
  return (
    knownIds.size +
    messagesById.size +
    messagesByAddress.size +
    threads.size +
    timeline.length +
    range.endIndex -
    range.startIndex +
    projectedContentBytes +
    Math.floor(layout.totalSize)
  );
};

const runTraversal = (pages: readonly ChannelHistoryPage[], strategy: StrategyId): TraversalRun => {
  let state: LoadedChannelHistory | undefined;
  let window = boundedStrategy(strategy) ? emptyChannelMessageWindow() : null;
  let initialMergeMs = 0;
  const olderMergeMs: number[] = [];
  const projectionMs: number[] = [];
  let totalMergeMs = 0;
  let totalProjectionMs = 0;
  let evictedOlder = 0;
  let evictedNewer = 0;
  let peakRetainedBytes = 0;
  let maxPrimaryMessages = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (!page) continue;
    const mergeStartedAt = performance.now();
    if (window) {
      const transition = applyPrimaryHistoryPage({
        current: state,
        window,
        page,
        mode: pageIndex === 0 ? "replace" : "older",
        atBottom: pageIndex === 0,
        loadedAt: 1,
      });
      state = transition.history;
      window = transition.window;
      evictedOlder += transition.evictedOlder;
      evictedNewer += transition.evictedNewer;
      peakRetainedBytes = Math.max(peakRetainedBytes, window.retainedBytes);
      observableChecksum += transitionChecksum(transition);
    } else {
      // Keep the current/unbounded arm as the exact pre-production baseline.
      state = mergeLoadedChannelHistoryPage(state, page, pageIndex === 0 ? "replace" : "older", 1);
    }
    const mergeMs = performance.now() - mergeStartedAt;
    totalMergeMs += mergeMs;
    if (pageIndex === 0) initialMergeMs = mergeMs;
    else olderMergeMs.push(mergeMs);
    maxPrimaryMessages = Math.max(maxPrimaryMessages, state.messages.length);

    const projectionStartedAt = performance.now();
    observableChecksum += projectHistoryForRenderer(state, window);
    const projectionDuration = performance.now() - projectionStartedAt;
    projectionMs.push(projectionDuration);
    totalProjectionMs += projectionDuration;
  }
  if (!state) state = emptyLoadedChannelHistory();
  return {
    state,
    window,
    initialMergeMs,
    olderMergeMs,
    projectionMs,
    totalMergeMs,
    totalProjectionMs,
    evictedOlder,
    evictedNewer,
    peakRetainedBytes,
    maxPrimaryMessages,
  };
};

const collectTraversal = (
  pages: readonly ChannelHistoryPage[],
  strategy: StrategyId
): { run: TraversalRun; metrics: Record<string, unknown> } => {
  runTraversal(pages, strategy);
  const runs: TraversalRun[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    Bun.gc(true);
    runs.push(runTraversal(pages, strategy));
  }
  const run = runs.at(-1) ?? runTraversal(pages, strategy);
  return {
    run,
    metrics: {
      initialPageMerge: distribution(runs.map((candidate) => candidate.initialMergeMs)),
      olderPageMergeAcrossDepths: distribution(runs.flatMap((candidate) => candidate.olderMergeMs)),
      totalMergeToTraverseHistory: distribution(runs.map((candidate) => candidate.totalMergeMs)),
      projectionAfterEachPageAcrossDepths: distribution(
        runs.flatMap((candidate) => candidate.projectionMs)
      ),
      totalProjectionToTraverseHistory: distribution(
        runs.map((candidate) => candidate.totalProjectionMs)
      ),
      productionWindow:
        strategy === "A_current_unbounded"
          ? undefined
          : {
              messageLimit: MESSAGE_HISTORY_MAX_MESSAGES,
              retainedByteLimit: MESSAGE_HISTORY_MAX_RETAINED_BYTES,
              maxPrimaryMessages: Math.max(
                ...runs.map((candidate) => candidate.maxPrimaryMessages)
              ),
              peakRetainedBytes: Math.max(...runs.map((candidate) => candidate.peakRetainedBytes)),
              finalRetainedBytes: run.window?.retainedBytes ?? 0,
              evictedOlder: run.evictedOlder,
              evictedNewer: run.evictedNewer,
              primaryHasNewerGap: run.window?.primaryHasNewerGap ?? false,
            },
    },
  };
};

const retainedMetrics = (
  history: LoadedChannelHistory,
  window: ChannelMessageWindowState | null = null
): Record<string, number | boolean> => {
  const lanes = [
    history.messages,
    history.threadContext,
    history.searchContext,
    history.searchThreadContext,
    ...(window?.latestTail ? [window.latestTail.messages, window.latestTail.threadContext] : []),
  ];
  const unique = new Map<string, ChannelMessageView>();
  for (const lane of lanes) {
    for (const message of lane) unique.set(message.id, message);
  }
  const messages = [...unique.values()].sort(compareEntitySequence);
  return {
    primaryMessages: history.messages.length,
    searchContextMessages: history.searchContext.length,
    threadContextMessages: history.threadContext.length + history.searchThreadContext.length,
    laneMessageReferences: lanes.reduce((total, lane) => total + lane.length, 0),
    uniqueMessages: messages.length,
    serializedMessageBytes: byteLength(messages),
    contentAndMetadataUtf8Bytes: messages.reduce(
      (total, message) => total + payloadByteLength(message),
      0
    ),
    ...(window
      ? {
          latestTailMessages: window.latestTail?.messages.length ?? 0,
          latestTailThreadContextMessages: window.latestTail?.threadContext.length ?? 0,
          productionRetainedBytes: window.retainedBytes,
          productionMessageLimit: MESSAGE_HISTORY_MAX_MESSAGES,
          productionRetainedByteLimit: MESSAGE_HISTORY_MAX_RETAINED_BYTES,
          primaryHasNewerGap: window.primaryHasNewerGap,
        }
      : {}),
  };
};

const measurePoint = (work: () => number, samples = pointSamples): Distribution => {
  for (let warmup = 0; warmup < 5; warmup += 1) observableChecksum += work();
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    observableChecksum += work();
    durations.push(performance.now() - startedAt);
  }
  return distribution(durations);
};

const recentWindowState = (
  pages: readonly ChannelHistoryPage[],
  strategy: StrategyId
): BenchmarkHistoryState => {
  let state: LoadedChannelHistory | undefined;
  let window = boundedStrategy(strategy) ? emptyChannelMessageWindow() : null;
  for (const [index, page] of pages.slice(0, ROLLING_PAGE_COUNT).entries()) {
    if (window) {
      const transition = applyPrimaryHistoryPage({
        current: state,
        window,
        page,
        mode: index === 0 ? "replace" : "older",
        atBottom: index === 0,
        loadedAt: 1,
      });
      state = transition.history;
      window = transition.window;
    } else {
      state = mergeLoadedChannelHistoryPage(state, page, index === 0 ? "replace" : "older", 1);
    }
  }
  return { history: state ?? emptyLoadedChannelHistory(), window };
};

const appendPageFor = (messages: readonly ChannelMessageView[], profile: PayloadProfile) => {
  const appended = messageAt(messages.length, profile);
  const pageMessages = [...messages.slice(-(PAGE_SIZE - 1)), appended];
  return createHistoryPage(pageMessages, messages.length + 1 > PAGE_SIZE);
};

const appendMetrics = (
  base: BenchmarkHistoryState,
  page: ChannelHistoryPage,
  strategy: StrategyId
): Record<string, unknown> => {
  if (strategy === "A_current_unbounded") {
    const projectedState = mergeLoadedChannelHistoryPage(base.history, page, "refresh", 2);
    const merge = measurePoint(() => {
      const next = mergeLoadedChannelHistoryPage(base.history, page, "refresh", 2);
      return next.messages.length;
    });
    return {
      basePrimaryMessages: base.history.messages.length,
      mergedPrimaryMessages: projectedState.messages.length,
      latestPageRefreshMerge: merge,
      rendererProjectionAfterRefresh: measurePoint(() => projectHistoryForRenderer(projectedState)),
    };
  }

  const projected = applyPrimaryHistoryPage({
    current: base.history,
    window: base.window ?? emptyChannelMessageWindow(),
    page,
    mode: "refresh",
    atBottom: true,
    loadedAt: 2,
  });
  const merge = measurePoint(() => {
    const next = applyPrimaryHistoryPage({
      current: base.history,
      window: base.window ?? emptyChannelMessageWindow(),
      page,
      mode: "refresh",
      atBottom: true,
      loadedAt: 2,
    });
    return transitionChecksum(next);
  });
  return {
    basePrimaryMessages: base.history.messages.length,
    mergedPrimaryMessages: projected.history.messages.length,
    productionRetainedBytes: projected.window.retainedBytes,
    evictedOlder: projected.evictedOlder,
    evictedNewer: projected.evictedNewer,
    outcome: projected.outcome,
    latestPageRefreshMerge: merge,
    rendererProjectionAfterRefresh: measurePoint(() =>
      projectHistoryForRenderer(projected.history, projected.window)
    ),
  };
};

const finalProjectionMetrics = (
  state: LoadedChannelHistory,
  window: ChannelMessageWindowState | null
): Record<string, unknown> => ({
  retained: retainedMetrics(state, window),
  rendererProjection: measurePoint(() => projectHistoryForRenderer(state, window)),
});

const returnToNewestMetrics = (
  run: TraversalRun,
  strategy: StrategyId
): Record<string, unknown> => {
  if (strategy === "A_current_unbounded") {
    return {
      additionalRequests: 0,
      responseJsonBytes: 0,
      note: "Newest messages are still retained.",
    };
  }
  const reset = run.window ? resetToLatestTail(run.state, run.window, 2) : null;
  if (!reset) {
    return {
      additionalRequests: 0,
      responseJsonBytes: 0,
      note: "The bounded primary window still contains the newest messages.",
    };
  }
  return {
    additionalRequests: 0,
    responseJsonBytes: 0,
    note: "The production reducer swaps its retained latest tail into view without a request.",
    cachedTailMessages: reset.history.messages.length,
    cachedTailRetainedBytes: reset.window.retainedBytes,
    cachedTailResetMerge: measurePoint(() => {
      const next = run.window ? resetToLatestTail(run.state, run.window, 2) : null;
      return next ? transitionChecksum(next) : 0;
    }),
  };
};

const mergeSearchWindow = (
  current: readonly ChannelMessageView[],
  incoming: readonly ChannelMessageView[],
  direction: Direction
): ChannelMessageView[] => {
  const merged = sortedUniqueMessages([...current, ...incoming]).sort(compareEntitySequence);
  if (merged.length <= ROLLING_MESSAGE_LIMIT) return merged;
  return direction === "older"
    ? merged.slice(0, ROLLING_MESSAGE_LIMIT)
    : merged.slice(-ROLLING_MESSAGE_LIMIT);
};

const buildContextExpansionPlan = (
  messages: readonly ChannelMessageView[],
  initial: MessageWindowTransition
): {
  steps: ContextExpansionStep[];
  final: MessageWindowTransition;
  addedOlder: number;
  addedNewer: number;
} => {
  const indexById = new Map(messages.map((message, index) => [message.id, index] as const));
  const steps: ContextExpansionStep[] = [];
  let transition = initial;
  let addedOlder = 0;
  let addedNewer = 0;
  for (const direction of ["older", "newer"] as const) {
    let remaining = Math.max(
      0,
      SEARCH_NEWER_DISTANCE - (direction === "older" ? CONTEXT_BEFORE : CONTEXT_AFTER)
    );
    while (remaining > 0) {
      const edge =
        direction === "older"
          ? transition.history.searchContext[0]
          : transition.history.searchContext.at(-1);
      const anchorIndex = edge ? indexById.get(edge.id) : undefined;
      if (anchorIndex === undefined) break;
      const page = createDirectionalContext(
        messages,
        anchorIndex,
        direction,
        Math.min(PAGE_SIZE, remaining)
      );
      if (!page) break;
      const existingIds = new Set(transition.history.searchContext.map((message) => message.id));
      const added = page.messages.reduce(
        (total, message) => total + (existingIds.has(message.id) ? 0 : 1),
        0
      );
      if (added === 0) break;
      steps.push({ direction, page });
      transition = expandMessageContext({
        current: transition.history,
        window: transition.window,
        page,
        direction,
        loadedAt: 3 + steps.length,
      });
      if (direction === "older") addedOlder += added;
      else addedNewer += added;
      remaining -= added;
    }
  }
  return { steps, final: transition, addedOlder, addedNewer };
};

const boundedContextMetrics = (
  messages: readonly ChannelMessageView[],
  latestPage: ChannelHistoryPage,
  context: ChannelMessageContextView
): Record<string, unknown> => {
  const recent = applyPrimaryHistoryPage({
    current: undefined,
    window: undefined,
    page: latestPage,
    mode: "replace",
    atBottom: true,
    loadedAt: 1,
  });
  const around = enterMessageContext(recent.history, recent.window, context, 2);
  const aroundMerge = measurePoint(() =>
    transitionChecksum(enterMessageContext(recent.history, recent.window, context, 2))
  );
  const plan = buildContextExpansionPlan(messages, around);
  const runExpansion = () => {
    let transition = around;
    let checksum = 0;
    let evictedOlder = 0;
    let evictedNewer = 0;
    for (const [index, step] of plan.steps.entries()) {
      transition = expandMessageContext({
        current: transition.history,
        window: transition.window,
        page: step.page,
        direction: step.direction,
        loadedAt: 3 + index,
      });
      evictedOlder += transition.evictedOlder;
      evictedNewer += transition.evictedNewer;
      checksum +=
        transitionChecksum(transition) +
        projectHistoryForRenderer(transition.history, transition.window);
    }
    return { transition, checksum, evictedOlder, evictedNewer };
  };
  runExpansion();
  const durations: number[] = [];
  let finalRun = {
    transition: plan.final,
    checksum: transitionChecksum(plan.final),
    evictedOlder: 0,
    evictedNewer: 0,
  };
  for (let sample = 0; sample < pointSamples; sample += 1) {
    const startedAt = performance.now();
    finalRun = runExpansion();
    durations.push(performance.now() - startedAt);
    observableChecksum += finalRun.checksum;
  }
  const requestsByDirection = plan.steps.reduce(
    (counts, step) => {
      counts[step.direction] += 1;
      return counts;
    },
    { older: 0, newer: 0 }
  );
  return {
    aroundWindow: {
      returnedMessages: context.messages.length,
      visibleMessages: visibleChannelHistoryMessages(around.history, around.window).length,
      mergeWithProductionReducer: aroundMerge,
      rendererProjection: measurePoint(() =>
        projectHistoryForRenderer(around.history, around.window)
      ),
      evictedOlder: around.evictedOlder,
      evictedNewer: around.evictedNewer,
      retained: retainedMetrics(around.history, around.window),
    },
    bidirectionalExpansion: {
      requestedDistanceFromTargetPerDirection: SEARCH_NEWER_DISTANCE,
      addedOlderMessages: plan.addedOlder,
      addedNewerMessages: plan.addedNewer,
      requests: plan.steps.length,
      requestsByDirection,
      responseJsonBytes: plan.steps.reduce((total, step) => total + byteLength(step.page), 0),
      totalMergeAndProjection: distribution(durations),
      evictedOlder: finalRun.evictedOlder,
      evictedNewer: finalRun.evictedNewer,
      retained: retainedMetrics(finalRun.transition.history, finalRun.transition.window),
    },
  };
};

const deepSearchMetrics = (
  messages: readonly ChannelMessageView[],
  pages: readonly ChannelHistoryPage[]
): Record<string, unknown> | null => {
  if (messages.length < PAGE_SIZE + CONTEXT_BEFORE + SEARCH_NEWER_DISTANCE) return null;
  const targetIndex = Math.max(CONTEXT_BEFORE, Math.floor(messages.length * 0.2));
  const context = createContext(messages, targetIndex);
  const latestPage = pages[0];
  if (!latestPage) return null;
  const recent = mergeLoadedChannelHistoryPage(undefined, latestPage, "replace", 1);
  const around = mergeLoadedChannelMessageContext(recent, context, 2);
  const sequentialPagesWithoutContextEndpoint = Math.ceil(
    (messages.length - targetIndex) / PAGE_SIZE
  );
  const contextWireBytes = byteLength(context);

  const aroundMerge = measurePoint(() => {
    const next = mergeLoadedChannelMessageContext(recent, context, 2);
    return next.searchContext.length;
  });
  const aroundProjection = measurePoint(() => projectHistoryForRenderer(around));

  const continuationPages: ChannelMessageView[][] = [];
  let nextStart = Math.min(messages.length, targetIndex + CONTEXT_AFTER + 1);
  const desiredEnd = Math.min(messages.length, targetIndex + SEARCH_NEWER_DISTANCE + 1);
  while (nextStart < desiredEnd) {
    const nextEnd = Math.min(desiredEnd, nextStart + PAGE_SIZE);
    continuationPages.push(messages.slice(nextStart, nextEnd));
    nextStart = nextEnd;
  }

  const runContinuation = () => {
    let history = around;
    let searchWindow = context.messages;
    let checksum = 0;
    for (const continuationPage of continuationPages) {
      searchWindow = mergeSearchWindow(searchWindow, continuationPage, "newer");
      history = mergeLoadedChannelMessageContext(
        history,
        {
          messages: searchWindow,
          threadContext: [],
          threadContextTruncated: false,
        },
        3
      );
      checksum += projectHistoryForRenderer(history);
    }
    return { history, checksum };
  };
  runContinuation();
  const continuationDurations: number[] = [];
  let continuationState = around;
  for (let sample = 0; sample < pointSamples; sample += 1) {
    const startedAt = performance.now();
    const result = runContinuation();
    continuationDurations.push(performance.now() - startedAt);
    continuationState = result.history;
    observableChecksum += result.checksum;
  }
  const productionBoundedContext = boundedContextMetrics(messages, latestPage, context);

  return {
    target: {
      index: targetIndex,
      sequence: messages[targetIndex]?.sequence ?? null,
      percentileThroughTranscript: round(targetIndex / messages.length, 2),
    },
    coldOpenRequestsIncludingLatestPage: 2,
    warmOpenAdditionalRequests: 1,
    sequentialOlderOnlyRequestsWithoutContextEndpoint: sequentialPagesWithoutContextEndpoint,
    aroundWindow: {
      before: CONTEXT_BEFORE,
      target: 1,
      after: CONTEXT_AFTER,
      returnedMessages: context.messages.length,
      responseJsonBytes: contextWireBytes,
      mergeIntoExistingRecentLane: aroundMerge,
      rendererProjection: aroundProjection,
      retained: retainedMetrics(around),
    },
    newerContinuationFromSearch: {
      requestedDistanceFromTarget: SEARCH_NEWER_DISTANCE,
      alreadyCoveredAfterTarget: CONTEXT_AFTER,
      additionalRequests: continuationPages.length,
      additionalResponseMessageBytes: continuationPages.reduce(
        (total, page) => total + byteLength(page),
        0
      ),
      totalMergeAndProjection: distribution(continuationDurations),
      retained: retainedMetrics(continuationState),
    },
    productionReducerByBoundedStrategy: {
      B_bounded_older_only: {
        aroundWindow: productionBoundedContext.aroundWindow,
        bidirectionalExpansion: {
          supported: false,
          reason: "The older-only strategy does not retain a newer context cursor.",
        },
      },
      C_search_bidirectional: productionBoundedContext,
    },
    supportByStrategy: {
      A_current_unbounded: {
        directAroundOpen: true,
        seamlessNewerBeyondReturnedContext: false,
        reason: "The current client discards hasMoreAfter/afterSequence from message context.",
      },
      B_bounded_older_only: {
        directAroundOpen: true,
        seamlessNewerBeyondReturnedContext: false,
        reason: "An older-only rolling cursor cannot fill the newer side of an around window.",
      },
      C_search_bidirectional: {
        directAroundOpen: true,
        seamlessNewerBeyondReturnedContext: true,
        reason: "Only search/deep-link context retains the existing before/after cursors.",
      },
    },
  };
};

const benchmarkWorkload = (definition: WorkloadDefinition): Record<string, unknown> => {
  const messages = createMessages(definition.messageCount, definition.payloadProfile);
  const pages = createHistoryPages(messages);
  const appendPage = appendPageFor(messages, definition.payloadProfile);
  const responseBytes = pages.map((page) => byteLength(page));
  const strategies = {} as Record<StrategyId, Record<string, unknown>>;

  for (const strategy of [
    "A_current_unbounded",
    "B_bounded_older_only",
    "C_search_bidirectional",
  ] as const) {
    const traversal = collectTraversal(pages, strategy);
    const appendBase =
      strategy === "A_current_unbounded"
        ? { history: traversal.run.state, window: traversal.run.window }
        : recentWindowState(pages, strategy);
    strategies[strategy] = {
      behavior:
        strategy === "A_current_unbounded"
          ? "Current older-only cursor; every loaded page remains in the active history."
          : strategy === "B_bounded_older_only"
            ? `Production older-only primary reducer capped at ${ROLLING_MESSAGE_LIMIT} messages and ${MESSAGE_HISTORY_MAX_RETAINED_BYTES} retained bytes; returning newest uses its cached tail or reloads the latest page.`
            : `Same production bounded normal-history reducer as B; before/after expansion exists only in a separate bounded search/deep-link context lane.`,
      historyTraversal: {
        initialRequests: pages.length > 0 ? 1 : 0,
        olderRequests: Math.max(0, pages.length - 1),
        totalRequests: pages.length,
        totalResponseJsonBytes: responseBytes.reduce((total, value) => total + value, 0),
        ...traversal.metrics,
      },
      afterCompleteOlderTraversal: finalProjectionMetrics(
        traversal.run.state,
        traversal.run.window
      ),
      appendAtSteadyState: appendMetrics(appendBase, appendPage, strategy),
      returnToNewestAfterCompleteOlderTraversal: returnToNewestMetrics(traversal.run, strategy),
    };
  }

  const unboundedBytes = (
    strategies.A_current_unbounded.afterCompleteOlderTraversal as {
      retained: { serializedMessageBytes: number };
    }
  ).retained.serializedMessageBytes;
  const boundedBytes = (
    strategies.B_bounded_older_only.afterCompleteOlderTraversal as {
      retained: { serializedMessageBytes: number };
    }
  ).retained.serializedMessageBytes;

  return {
    id: definition.id,
    classification: definition.classification,
    fixture: {
      messageCount: messages.length,
      payloadProfile: definition.payloadProfile,
      totalSerializedMessageBytes: byteLength(messages),
      totalContentAndMetadataUtf8Bytes: messages.reduce(
        (total, message) => total + payloadByteLength(message),
        0
      ),
      meanSerializedMessageBytes: round(byteLength(messages) / Math.max(1, messages.length)),
      pages: pages.length,
    },
    strategies,
    deepSearch: deepSearchMetrics(messages, pages),
    derived: {
      boundedRetainedSerializedByteReductionPercent:
        unboundedBytes > 0 ? round((1 - boundedBytes / unboundedBytes) * 100, 1) : 0,
      normalPathCEqualsBByDesign: true,
    },
  };
};

const benchmarkStartedAt = performance.now();
const results = workloads.map(benchmarkWorkload);
const elapsedMs = performance.now() - benchmarkStartedAt;

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
  },
  parameters: {
    pageSize: PAGE_SIZE,
    rollingPageCount: ROLLING_PAGE_COUNT,
    rollingMessageLimit: ROLLING_MESSAGE_LIMIT,
    retainedByteLimit: MESSAGE_HISTORY_MAX_RETAINED_BYTES,
    contextBefore: CONTEXT_BEFORE,
    contextAfter: CONTEXT_AFTER,
    searchNewerDistance: SEARCH_NEWER_DISTANCE,
    traversalIterations: iterations,
    pointSamples,
    fixedFixtureEpoch: new Date(FIXED_EPOCH_MS).toISOString(),
  },
  methodology: {
    actualOpenTeamHelpers: [
      "mergeLoadedChannelHistoryPage",
      "mergeLoadedChannelMessageContext",
      "loadedChannelHistoryMessages",
      "sortedUniqueMessages",
      "deriveThreads",
      "messageRenderKey",
      "channelMessageAddress",
      "messageDisplayProjection",
      "computeVirtualLayout",
      "computeVirtualRangeFromLayout",
      "applyPrimaryHistoryPage",
      "enterMessageContext",
      "expandMessageContext",
      "resetToLatestTail",
      "visibleChannelHistoryMessages",
    ],
    measured:
      "Synchronous client merge and renderer data-projection CPU on deterministic in-memory server pages.",
    retainedBytes:
      "Exact UTF-8 JSON serialization and content+metadata bytes of unique retained messages, plus the production reducer's retained-byte accounting; these are deterministic payload-size proxies, not JavaScript heap measurements.",
    excluded:
      "HTTP/database latency, React commit, Markdown/highlighter initialization, DOM measurement, image decode, compositor work, and Electron IPC.",
    interpretation:
      "Compare ratios and scaling on the same machine. Sub-millisecond absolute timings are timer/JIT sensitive.",
  },
  results,
  elapsedMs: round(elapsedMs),
  observableChecksum,
};

const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
if (outputArgument) {
  const outputPath = resolve(outputArgument.slice("--output=".length));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  console.error(`Wrote ${outputPath}`);
}
process.stdout.write(serialized);
