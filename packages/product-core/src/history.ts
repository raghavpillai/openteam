import type {
  ChannelClientState,
  ChannelHistoryPage,
  ChannelMessageContextView,
  ChannelMessageView,
  ClientBootstrapView,
  ClientSnapshot,
} from "@openteam/contracts";

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

export const MAX_INACTIVE_HISTORY_CHANNELS = 3;
export const MAX_INACTIVE_MESSAGES_PER_CHANNEL = 120;
export const MAX_CACHED_MESSAGES_PER_CHANNEL = 200;

export interface ChannelHistoryState {
  beforeSequence: string | null;
  hasMore: boolean;
  loading: boolean;
}

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
export const messageCreatedAtMs = (message: { createdAt: string }): number => {
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

/** A latest-page refresh must not rewind pagination already loaded for the active channel. */
export const reconcileActiveHistoryRefresh = (
  current: ChannelHistoryState | undefined,
  latest: ChannelHistoryState
): ChannelHistoryState => {
  const loading = current?.loading ?? latest.loading;
  if (!current?.beforeSequence || !latest.beforeSequence) return { ...latest, loading };
  const currentCursor = numericCursor(current.beforeSequence);
  const latestCursor = numericCursor(latest.beforeSequence);
  return currentCursor !== null && latestCursor !== null && currentCursor < latestCursor
    ? { ...current, loading }
    : { ...latest, loading };
};

const messageOrder = (left: ChannelMessageView, right: ChannelMessageView): number =>
  messageCreatedAtMs(left) - messageCreatedAtMs(right) || left.id.localeCompare(right.id);

const metadataFor = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const preservingClientDelivery = (
  previous: ChannelMessageView,
  incoming: ChannelMessageView
): ChannelMessageView => {
  const clientDelivery = metadataFor(previous).clientDelivery;
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

export type ChannelHistoryMergeMode = "replace" | "refresh" | "older";

/** Merge a server page into the normalized primary/thread/search history lanes. */
export const mergeLoadedChannelHistoryPage = (
  current: LoadedChannelHistory | undefined,
  page: ChannelHistoryPage,
  mode: ChannelHistoryMergeMode,
  loadedAt = Date.now()
): LoadedChannelHistory => {
  const base = emptyLoadedChannelHistory(current);
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
  return {
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
  };
};

export const mergeLoadedChannelMessageContext = (
  current: LoadedChannelHistory,
  context: Pick<ChannelMessageContextView, "messages" | "threadContext" | "threadContextTruncated">,
  loadedAt = Date.now()
): LoadedChannelHistory => {
  const primaryIds = new Set(current.messages.map((message) => message.id));
  const searchContext = withoutVisibleMessages(context.messages, primaryIds);
  const visibleIds = new Set([...primaryIds, ...searchContext.map((message) => message.id)]);
  const threadContextIds = new Set(current.threadContext.map((message) => message.id));
  return {
    ...current,
    searchContext,
    searchThreadContext: withoutVisibleMessages(
      context.threadContext ?? [],
      visibleIds,
      threadContextIds
    ),
    searchThreadContextTruncated: context.threadContextTruncated,
    loadedAt,
  };
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

export const loadedChannelHistoryMessages = (history: LoadedChannelHistory): ChannelMessageView[] =>
  sortedUniqueMessages([
    ...history.searchThreadContext,
    ...history.threadContext,
    ...history.searchContext,
    ...history.messages,
  ]).sort(compareEntitySequence);

export const snapshotFromBootstrap = (bootstrap: ClientBootstrapView): ClientSnapshot => ({
  cursor: bootstrap.cursor,
  workspace: bootstrap.workspace,
  bots: bootstrap.bots,
  channels: bootstrap.channels,
  channelMessages: bootstrap.latestMessages,
  channelRounds: bootstrap.channelRounds,
  runs: bootstrap.activeRuns,
  runItems: [],
  approvals: bootstrap.pendingApprovals,
  subagents: bootstrap.subagents,
  runtime: bootstrap.runtime,
});

export const touchHistoryLru = (current: readonly string[], channelId: string): string[] =>
  [channelId, ...current.filter((candidate) => candidate !== channelId)].slice(
    0,
    MAX_INACTIVE_HISTORY_CHANNELS
  );

export const retainedHistoryIds = (
  activeChannelId: string | null,
  inactiveLru: readonly string[]
): Set<string> =>
  new Set([
    ...(activeChannelId ? [activeChannelId] : []),
    ...inactiveLru.slice(0, MAX_INACTIVE_HISTORY_CHANNELS),
  ]);

export const mergeBootstrapWithHistory = (
  bootstrap: ClientBootstrapView,
  current: ClientSnapshot,
  retainedIds: ReadonlySet<string>
): ClientSnapshot => {
  const base = snapshotFromBootstrap(bootstrap);
  const visibleChannels = new Set(base.channels.map((channel) => channel.id));
  const retained = current.channelMessages.filter(
    (message) => visibleChannels.has(message.channelId) && retainedIds.has(message.channelId)
  );
  return {
    ...base,
    channelMessages: sortedUniqueMessages([...base.channelMessages, ...retained]),
  };
};

export const mergeChannelMessages = (
  snapshot: ClientSnapshot,
  channelId: string,
  incoming: readonly ChannelMessageView[]
): ClientSnapshot => ({
  ...snapshot,
  channelMessages: sortedUniqueMessages([
    ...snapshot.channelMessages.filter((message) => message.channelId !== channelId),
    ...snapshot.channelMessages.filter((message) => message.channelId === channelId),
    ...incoming,
  ]),
});

/** Replace one channel's bounded activity projection without disturbing other retained channels. */
export const mergeChannelState = (
  snapshot: ClientSnapshot,
  state: ChannelClientState
): ClientSnapshot => {
  const previousRunIds = new Set(
    snapshot.runs.filter((run) => run.channelId === state.channelId).map((run) => run.id)
  );
  const replacementRunIds = new Set(state.runs.map((run) => run.id));
  const replacedRunIds = new Set([...previousRunIds, ...replacementRunIds]);
  return {
    ...snapshot,
    channelRounds: uniqueEntitiesById(
      snapshot.channelRounds.filter((round) => round.channelId !== state.channelId),
      state.channelRounds
    ),
    runs: uniqueEntitiesById(
      snapshot.runs.filter((run) => run.channelId !== state.channelId),
      state.runs
    ),
    runItems: uniqueEntitiesById(
      snapshot.runItems.filter((item) => !replacedRunIds.has(item.runId)),
      state.runItems
    ),
    approvals: uniqueEntitiesById(
      snapshot.approvals.filter((approval) => !replacedRunIds.has(approval.runId)),
      state.approvals
    ),
    subagents: uniqueEntitiesById(
      snapshot.subagents.filter((subagent) => subagent.parentChannelId !== state.channelId),
      state.subagents
    ),
  };
};

export const mergeBootstrapActivityStates = (
  bootstrap: ClientBootstrapView,
  states: readonly ChannelClientState[]
): Pick<ClientSnapshot, "channelRounds" | "runs" | "runItems" | "approvals" | "subagents"> => ({
  channelRounds: uniqueEntitiesById(
    bootstrap.channelRounds,
    ...states.map((state) => state.channelRounds)
  ),
  runs: uniqueEntitiesById(bootstrap.activeRuns, ...states.map((state) => state.runs)),
  runItems: uniqueEntitiesById(...states.map((state) => state.runItems)),
  approvals: uniqueEntitiesById(
    bootstrap.pendingApprovals,
    ...states.map((state) => state.approvals)
  ),
  subagents: uniqueEntitiesById(bootstrap.subagents, ...states.map((state) => state.subagents)),
});

export const trimInactiveHistories = (
  snapshot: ClientSnapshot,
  activeChannelId: string | null,
  inactiveLru: readonly string[]
): ClientSnapshot => {
  const visibleChannels = new Set(snapshot.channels.map((channel) => channel.id));
  const retained = retainedHistoryIds(activeChannelId, inactiveLru);
  const byChannel = new Map<string, ChannelMessageView[]>();
  for (const message of snapshot.channelMessages) {
    if (!visibleChannels.has(message.channelId)) continue;
    const current = byChannel.get(message.channelId);
    if (current) current.push(message);
    else byChannel.set(message.channelId, [message]);
  }
  const messages: ChannelMessageView[] = [];
  for (const [channelId, channelMessages] of byChannel) {
    const sorted = sortedUniqueMessages(channelMessages);
    if (channelId === activeChannelId) messages.push(...sorted);
    else if (retained.has(channelId))
      messages.push(...sorted.slice(-MAX_INACTIVE_MESSAGES_PER_CHANNEL));
    else {
      const latest = sorted.at(-1);
      if (latest) messages.push(latest);
    }
  }
  return { ...snapshot, channelMessages: messages.sort(messageOrder) };
};

/** Persist the bootstrap plus a bounded recent window for retained conversations. */
export const boundedSnapshotForCache = (
  snapshot: ClientSnapshot,
  retainedIds: readonly string[]
): ClientSnapshot => {
  const historyIds = new Set(retainedIds.slice(0, MAX_INACTIVE_HISTORY_CHANNELS + 1));
  const byChannel = new Map<string, ChannelMessageView[]>();
  for (const message of snapshot.channelMessages) {
    const current = byChannel.get(message.channelId);
    if (current) current.push(message);
    else byChannel.set(message.channelId, [message]);
  }
  const messages: ChannelMessageView[] = [];
  for (const channelMessages of byChannel.values()) {
    const sorted = sortedUniqueMessages(channelMessages);
    const latest = sorted.at(-1);
    if (!latest) continue;
    if (historyIds.has(latest.channelId))
      messages.push(...sorted.slice(-MAX_CACHED_MESSAGES_PER_CHANNEL));
    else messages.push(latest);
  }
  return { ...snapshot, channelMessages: messages.sort(messageOrder) };
};

export const latestNumericSequence = (
  messages: readonly ChannelMessageView[],
  channelId: string
): string | null => {
  let latest: bigint | null = null;
  for (const message of messages) {
    if (message.channelId !== channelId || !/^\d+$/.test(message.sequence)) continue;
    const sequence = BigInt(message.sequence);
    if (latest === null || sequence > latest) latest = sequence;
  }
  return latest?.toString() ?? null;
};
