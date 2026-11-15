import type {
  ChannelClientState,
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
  ClientBootstrapView,
  ClientSnapshot,
} from "@openteam/contracts";
import { createQuestionReceiptStore, preserveQuestionReceipt } from "./questions";

export interface LoadedChannelHistory {
  messages: ChannelMessageView[];
  threadContext: ChannelMessageView[];
  searchContext: ChannelMessageView[];
  searchThreadContext: ChannelMessageView[];
  threadContextTruncated: boolean;
  searchThreadContextTruncated: boolean;
  beforeSequence: string | null;
  hasMore: boolean;
  loading: boolean;
  loadedAt: number;
}

export const emptyLoadedChannelHistory = (
  current?: LoadedChannelHistory
): LoadedChannelHistory => ({
  messages: current?.messages ?? [],
  threadContext: current?.threadContext ?? [],
  searchContext: current?.searchContext ?? [],
  searchThreadContext: current?.searchThreadContext ?? [],
  threadContextTruncated: current?.threadContextTruncated ?? false,
  searchThreadContextTruncated: current?.searchThreadContextTruncated ?? false,
  beforeSequence: current?.beforeSequence ?? null,
  hasMore: current?.hasMore ?? false,
  loading: false,
  loadedAt: current?.loadedAt ?? 0,
});

export const loadingChannelHistory = (current?: LoadedChannelHistory): LoadedChannelHistory => ({
  ...emptyLoadedChannelHistory(current),
  loading: true,
});

const numericCursor = (value: string | null): bigint | null =>
  value && /^\d+$/.test(value) ? BigInt(value) : null;

// Sorting the same retained window repeatedly used to parse each date/sequence
// O(n log n) times. Weak keys follow the lifetime of the bounded message window;
// checking the source value also keeps these helpers correct for mutable callers.
const sequenceValues = new WeakMap<object, { source: string; value: bigint | null }>();
const sequenceValue = (entity: { sequence: string }): bigint | null => {
  const cached = sequenceValues.get(entity);
  if (cached?.source === entity.sequence) return cached.value;
  const value = numericCursor(entity.sequence);
  sequenceValues.set(entity, { source: entity.sequence, value });
  return value;
};
const createdAtValues = new WeakMap<object, { source: string; value: number }>();
const messageCreatedAtMs = (message: { createdAt: string }): number => {
  const cached = createdAtValues.get(message);
  if (cached?.source === message.createdAt) return cached.value;
  const value = Date.parse(message.createdAt);
  createdAtValues.set(message, { source: message.createdAt, value });
  return value;
};

export const compareEntitySequence = (
  left: { sequence: string },
  right: { sequence: string }
): number => {
  const a = sequenceValue(left);
  const b = sequenceValue(right);
  return a !== null && b !== null
    ? a < b
      ? -1
      : a > b
        ? 1
        : 0
    : left.sequence.localeCompare(right.sequence);
};

export const uniqueEntitiesById = <T extends { id: string }>(
  ...collections: ReadonlyArray<readonly T[]>
): T[] => {
  const byId = new Map<string, T>();
  for (const collection of collections) {
    for (const entity of collection) byId.set(entity.id, entity);
  }
  return [...byId.values()];
};

/** Server sequence, not random UUID order, breaks equal-timestamp ties. */
export const compareMessageChronology = (left: ChannelMessageView, right: ChannelMessageView): number =>
  messageCreatedAtMs(left) - messageCreatedAtMs(right) || compareEntitySequence(left, right);

const messageOrder = (left: ChannelMessageView, right: ChannelMessageView): number =>
  compareMessageChronology(left, right) || left.id.localeCompare(right.id);

const metadataFor = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const preservingClientDelivery = (
  previous: ChannelMessageView,
  incoming: ChannelMessageView
): ChannelMessageView => {
  const previousMetadata = metadataFor(previous);
  incoming = preserveQuestionReceipt(previous, incoming);
  const clientDelivery = previousMetadata.clientDelivery;
  if (!clientDelivery || typeof clientDelivery !== "object" || Array.isArray(clientDelivery)) {
    return incoming;
  }
  const renderKey = (clientDelivery as Record<string, unknown>).renderKey;
  if (typeof renderKey !== "string") return incoming;
  return { ...incoming, metadata: { ...metadataFor(incoming), clientDelivery } };
};

export const sortedUniqueMessages = (
  messages: readonly ChannelMessageView[]
): ChannelMessageView[] => {
  const unique = new Map<string, ChannelMessageView>();
  for (const message of messages) {
    const previous = unique.get(message.id);
    unique.set(message.id, previous ? preservingClientDelivery(previous, message) : message);
  }
  return [...unique.values()].sort(messageOrder);
};

const withoutVisibleMessages = (
  messages: readonly ChannelMessageView[],
  visibleIds: ReadonlySet<string>,
  additionalIds: ReadonlySet<string> = new Set()
): ChannelMessageView[] =>
  sortedUniqueMessages(messages)
    .sort(compareEntitySequence)
    .filter((message) => !visibleIds.has(message.id) && !additionalIds.has(message.id));

type ChannelHistoryMergeMode = "replace" | "refresh" | "older";

export const restoreHistoryQuestionReceipts = (
  history: LoadedChannelHistory, receipts: ReturnType<typeof createQuestionReceiptStore>
): LoadedChannelHistory => receipts.size === 0 ? history : ({
  ...history,
  messages: history.messages.map(receipts.restore),
  threadContext: history.threadContext.map(receipts.restore),
  searchContext: history.searchContext.map(receipts.restore),
  searchThreadContext: history.searchThreadContext.map(receipts.restore),
});

const historyReceipts = (current: LoadedChannelHistory, incoming: readonly ChannelMessageView[]) => {
  const receipts = createQuestionReceiptStore();
  receipts.remember([...current.messages, ...current.threadContext, ...current.searchContext,
    ...current.searchThreadContext, ...incoming]);
  return receipts;
};

/** Merge a server page into the normalized primary/thread/search history lanes. */
export const mergeLoadedChannelHistoryPage = (
  current: LoadedChannelHistory | undefined,
  page: ChannelHistoryPage,
  mode: ChannelHistoryMergeMode,
  loadedAt = Date.now()
): LoadedChannelHistory => {
  const base = emptyLoadedChannelHistory(current);
  const receipts = historyReceipts(base, [...page.messages, ...(page.threadContext ?? [])]);
  const replace = mode === "replace" || base.loadedAt === 0;
  const messages = replace
    ? sortedUniqueMessages(page.messages).sort(compareEntitySequence)
    : sortedUniqueMessages(
        mode === "older"
          ? [...page.messages, ...base.messages]
          : [...base.messages, ...page.messages]
      ).sort(compareEntitySequence);
  const primaryIds = new Set(messages.map((message) => message.id));
  const searchContext = withoutVisibleMessages(base.searchContext, primaryIds);
  const visibleIds = new Set([...primaryIds, ...searchContext.map((message) => message.id)]);
  const threadContext = withoutVisibleMessages(
    [...(replace ? [] : base.threadContext), ...(page.threadContext ?? [])],
    visibleIds
  );
  const threadContextIds = new Set(threadContext.map((message) => message.id));
  return restoreHistoryQuestionReceipts({
    messages,
    searchContext,
    searchThreadContext: withoutVisibleMessages(
      base.searchThreadContext,
      visibleIds,
      threadContextIds
    ),
    threadContext,
    threadContextTruncated: replace
      ? page.threadContextTruncated
      : Boolean(base.threadContextTruncated || page.threadContextTruncated),
    searchThreadContextTruncated: base.searchThreadContextTruncated,
    beforeSequence: mode === "refresh" && !replace ? base.beforeSequence : page.beforeSequence,
    hasMore: mode === "refresh" && !replace ? base.hasMore : page.hasMore,
    loading: false,
    loadedAt,
  }, receipts);
};

export const mergeLoadedChannelMessageContext = (
  current: LoadedChannelHistory,
  context: Pick<ChannelMessageContextView, "messages" | "threadContext" | "threadContextTruncated">,
  loadedAt = Date.now()
): LoadedChannelHistory => {
  const receipts = historyReceipts(current, [...context.messages, ...(context.threadContext ?? [])]);
  const primaryIds = new Set(current.messages.map((message) => message.id));
  const searchContext = withoutVisibleMessages(context.messages, primaryIds);
  const visibleIds = new Set([...primaryIds, ...searchContext.map((message) => message.id)]);
  const threadContextIds = new Set(current.threadContext.map((message) => message.id));
  return restoreHistoryQuestionReceipts({
    ...current,
    searchContext,
    searchThreadContext: withoutVisibleMessages(
      context.threadContext ?? [],
      visibleIds,
      threadContextIds
    ),
    searchThreadContextTruncated: context.threadContextTruncated,
    loadedAt,
  }, receipts);
};

export const clearLoadedChannelSearchContext = (
  current: LoadedChannelHistory
): LoadedChannelHistory =>
  current.searchContext.length === 0 && current.searchThreadContext.length === 0
    ? current
    : {
        ...current,
        searchContext: [],
        searchThreadContext: [],
        searchThreadContextTruncated: false,
      };

export const mergeBootstrapActivityStates = (
  bootstrap: ClientBootstrapView,
  states: readonly ChannelClientState[]
): Pick<ClientSnapshot, "channelRounds" | "runs" | "runItems" | "subagents"> => ({
  channelRounds: uniqueEntitiesById(
    bootstrap.channelRounds,
    ...states.map((state) => state.channelRounds)
  ),
  runs: uniqueEntitiesById(bootstrap.activeRuns, ...states.map((state) => state.runs)),
  runItems: uniqueEntitiesById(...states.map((state) => state.runItems)),
  subagents: uniqueEntitiesById(bootstrap.subagents, ...states.map((state) => state.subagents)),
});
