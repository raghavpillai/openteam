import type { ClientSnapshot } from "@openbot/contracts";

type Entity = { id: string };
type EntityCache = Map<string, { fingerprint: string; value: Entity }>;

export type SnapshotCaches = Record<
  | "bots"
  | "channels"
  | "channelMessages"
  | "channelRounds"
  | "runs"
  | "runItems"
  | "approvals"
  | "subagents",
  EntityCache
>;

export const createSnapshotCaches = (): SnapshotCaches => ({
  bots: new Map(),
  channels: new Map(),
  channelMessages: new Map(),
  channelRounds: new Map(),
  runs: new Map(),
  runItems: new Map(),
  approvals: new Map(),
  subagents: new Map(),
});

const reconcileEntities = <T extends Entity>(
  cache: EntityCache,
  values: T[],
  previous: T[] | undefined
): T[] => {
  let unchanged = previous?.length === values.length;
  const live = new Set<string>();
  const reconciled = values.map((value, index) => {
    live.add(value.id);
    const fingerprint = JSON.stringify(value);
    const cached = cache.get(value.id);
    const nextValue = cached?.fingerprint === fingerprint ? (cached.value as T) : value;
    if (nextValue !== previous?.[index]) unchanged = false;
    if (cached?.fingerprint !== fingerprint) cache.set(value.id, { fingerprint, value });
    return nextValue;
  });
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  return unchanged && previous ? previous : reconciled;
};

const shallowEqualRecord = (a: object | undefined, b: object) =>
  Boolean(a) &&
  Object.keys(b).length === Object.keys(a!).length &&
  Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value);

export const reconcileClientSnapshot = (
  next: ClientSnapshot,
  previous: ClientSnapshot | null,
  caches: SnapshotCaches
): ClientSnapshot => {
  // The HTTP client is typed but the JSON is intentionally not decoded at
  // runtime. During HMR or a rolling upgrade an older server can omit a newly
  // introduced collection. Normalize every collection at this boundary so a
  // partial snapshot cannot strand the desktop on its connecting screen with
  // an unhelpful `undefined.length` error.
  const bots = Array.isArray(next.bots) ? next.bots : [];
  const channels = Array.isArray(next.channels) ? next.channels : [];
  const channelMessages = Array.isArray(next.channelMessages) ? next.channelMessages : [];
  const channelRounds = Array.isArray(next.channelRounds) ? next.channelRounds : [];
  const runs = Array.isArray(next.runs) ? next.runs : [];
  const runItems = Array.isArray(next.runItems) ? next.runItems : [];
  const approvals = Array.isArray(next.approvals) ? next.approvals : [];
  const subagents = Array.isArray(next.subagents) ? next.subagents : [];
  const reconciled: ClientSnapshot = {
    ...next,
    workspace: shallowEqualRecord(previous?.workspace, next.workspace)
      ? previous!.workspace
      : next.workspace,
    runtime: shallowEqualRecord(previous?.runtime, next.runtime) ? previous!.runtime : next.runtime,
    bots: reconcileEntities(caches.bots, bots, previous?.bots),
    channels: reconcileEntities(caches.channels, channels, previous?.channels),
    channelMessages: reconcileEntities(
      caches.channelMessages,
      channelMessages,
      previous?.channelMessages
    ),
    channelRounds: reconcileEntities(
      caches.channelRounds,
      channelRounds,
      previous?.channelRounds
    ),
    runs: reconcileEntities(caches.runs, runs, previous?.runs),
    runItems: reconcileEntities(caches.runItems, runItems, previous?.runItems),
    approvals: reconcileEntities(caches.approvals, approvals, previous?.approvals),
    subagents: reconcileEntities(caches.subagents, subagents, previous?.subagents),
  };
  if (
    previous &&
    previous.workspace === reconciled.workspace &&
    previous.runtime === reconciled.runtime &&
    previous.bots === reconciled.bots &&
    previous.channels === reconciled.channels &&
    previous.channelMessages === reconciled.channelMessages &&
    previous.channelRounds === reconciled.channelRounds &&
    previous.runs === reconciled.runs &&
    previous.runItems === reconciled.runItems &&
    previous.approvals === reconciled.approvals &&
    previous.subagents === reconciled.subagents
  ) {
    return previous;
  }
  return reconciled;
};
