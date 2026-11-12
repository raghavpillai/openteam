import type { ClientSnapshot } from "@openteam/contracts";

type Entity = { id: string };
type Fingerprint = { fingerprint: string; content?: string };
type EntityCache = Map<string, Fingerprint & { value: Entity }>;

// Limit inspection to small data trees. Rich/large metadata keeps the native
// serializer path rather than adding an unbounded walk to reconciliation.
const canSeparateContent = (value: Entity): boolean => {
  // Spread reads enumerable symbols; native JSON does not. Keep that path
  // untouched even when a symbol getter could otherwise change the body.
  if (Object.getOwnPropertySymbols(value).some(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable
  )) return false;
  let remaining = 64;
  const pending: object[] = [value];
  const isRawJSON = (JSON as typeof JSON & { isRawJSON?: (item: unknown) => boolean }).isRawJSON;
  while (pending.length) {
    if (--remaining < 0) return false;
    const current = pending.pop()!;
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) ||
      "toJSON" in current ||
      isRawJSON?.(current)
    ) return false;
    const length = array ? Object.getOwnPropertyDescriptor(current, "length")?.value : undefined;
    if (array && (typeof length !== "number" || length > remaining)) return false;
    const keys = Object.keys(current);
    if (keys.length > remaining || (array && keys.length !== length)) return false;
    remaining -= keys.length;
    for (const [index, key] of keys.entries()) {
      if (array && key !== String(index)) return false;
      const field = Object.getOwnPropertyDescriptor(current, key);
      // Nested getters/serializers can change the enclosing entity's content
      // before JSON reaches it. Preserve native order and side effects there.
      if (!field || !("value" in field)) return false;
      const item: unknown = field.value;
      if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint")
        return false;
      if (item !== null && typeof item === "object") pending.push(item);
    }
  }
  return true;
};

// Keep native JSON comparison for metadata and small entities. A full JSON copy
// of a long message/tool body can retain megabytes unnecessarily: compare that
// string directly, and fingerprint the other fields with its position intact.
const entityFingerprint = (value: Entity): Fingerprint => {
  const descriptor = Object.getOwnPropertyDescriptor(value, "content");
  const content = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof content === "string" && content.length >= 4 * 1024) {
    if (descriptor?.enumerable && canSeparateContent(value)) {
      return { fingerprint: JSON.stringify({ ...value, content: null }), content };
    }
  }
  return { fingerprint: JSON.stringify(value) };
};

// Eligibility can change without changing serialized data (for example sparse
// arrays become dense after JSON transport). Compare native full fingerprints
// transiently on those transitions, without retaining another body copy.
const fullFingerprint = ({ fingerprint, content }: Fingerprint): string => {
  if (content === undefined) return fingerprint;
  const serialized = JSON.parse(fingerprint) as { content: string | null };
  serialized.content = content;
  return JSON.stringify(serialized);
};

export type SnapshotCaches = Record<
  | "bots"
  | "channels"
  | "channelMessages"
  | "channelRounds"
  | "runs"
  | "runItems"
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
    const cached = cache.get(value.id);
    if (cached?.value === value) {
      if (value !== previous?.[index]) unchanged = false;
      return value;
    }
    const { fingerprint, content } = entityFingerprint(value);
    const sameRepresentation = (cached?.content === undefined) === (content === undefined);
    const equal = cached !== undefined && (sameRepresentation
      ? cached.fingerprint === fingerprint && cached.content === content
      : fullFingerprint(cached) === fullFingerprint({ fingerprint, content }));
    const nextValue = equal ? (cached.value as T) : value;
    if (nextValue !== previous?.[index]) unchanged = false;
    if (!equal || !sameRepresentation)
      cache.set(value.id, { fingerprint, content, value: nextValue });
    return nextValue;
  });
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  return unchanged && previous ? previous : reconciled;
};

const shallowEqualRecord = (left: object | undefined, right: object) =>
  Boolean(left) &&
  Object.keys(right).length === Object.keys(left!).length &&
  Object.entries(right).every(([key, value]) => (left as Record<string, unknown>)[key] === value);

export const reconcileClientSnapshot = (
  next: ClientSnapshot,
  previous: ClientSnapshot | null,
  caches: SnapshotCaches
): ClientSnapshot => {
  const bots = Array.isArray(next.bots) ? next.bots : [];
  const channels = Array.isArray(next.channels) ? next.channels : [];
  const channelMessages = Array.isArray(next.channelMessages) ? next.channelMessages : [];
  const channelRounds = Array.isArray(next.channelRounds) ? next.channelRounds : [];
  const runs = Array.isArray(next.runs) ? next.runs : [];
  const runItems = Array.isArray(next.runItems) ? next.runItems : [];
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
    channelRounds: reconcileEntities(caches.channelRounds, channelRounds, previous?.channelRounds),
    runs: reconcileEntities(caches.runs, runs, previous?.runs),
    runItems: reconcileEntities(caches.runItems, runItems, previous?.runItems),
    subagents: reconcileEntities(caches.subagents, subagents, previous?.subagents),
  };
  if (
    previous &&
    previous.notificationRouting === reconciled.notificationRouting &&
    previous.workspace === reconciled.workspace &&
    previous.runtime === reconciled.runtime &&
    previous.bots === reconciled.bots &&
    previous.channels === reconciled.channels &&
    previous.channelMessages === reconciled.channelMessages &&
    previous.channelRounds === reconciled.channelRounds &&
    previous.runs === reconciled.runs &&
    previous.runItems === reconciled.runItems &&
    previous.subagents === reconciled.subagents
  ) {
    return previous;
  }
  return reconciled;
};
