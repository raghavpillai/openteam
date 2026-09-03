import { normalizeClientSnapshot } from "@openteam/client-core/snapshot";
import type { ClientSnapshot } from "@openteam/contracts";
import { boundedSnapshotForCache } from "@openteam/product-core/history";
import * as FileSystem from "expo-file-system/legacy";

const legacyCachePath = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}openteam-client-snapshot.json`
  : null;
const cachePaths = FileSystem.documentDirectory
  ? [
      `${FileSystem.documentDirectory}openteam-client-snapshot.a.json`,
      `${FileSystem.documentDirectory}openteam-client-snapshot.b.json`,
    ]
  : [];
const CACHE_SCHEMA_VERSION = 2;
const CACHE_WRITE_DEBOUNCE_MS = 250;

interface CachedSnapshot {
  schemaVersion?: number;
  generation?: number;
  serverUrl: string;
  savedAt: string;
  snapshot: ClientSnapshot;
}

interface PendingSnapshot {
  serverUrl: string;
  retainedChannelIds: string[];
  snapshot: ClientSnapshot;
}

let lastGeneration = 0;
let pending: PendingSnapshot | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let drainPromise: Promise<void> | null = null;

const readCacheFile = async (path: string): Promise<CachedSnapshot | null> => {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<CachedSnapshot>;
    if (
      typeof candidate.serverUrl !== "string" ||
      typeof candidate.savedAt !== "string" ||
      !candidate.snapshot
    ) {
      return null;
    }
    return candidate as CachedSnapshot;
  } catch {
    return null;
  }
};

export const loadCachedSnapshot = async (serverUrl: string): Promise<ClientSnapshot | null> => {
  if (!serverUrl) return null;
  const candidates = await Promise.all([
    ...cachePaths.map(readCacheFile),
    ...(legacyCachePath ? [readCacheFile(legacyCachePath)] : []),
  ]);
  const match = candidates
    .filter((candidate): candidate is CachedSnapshot => candidate?.serverUrl === serverUrl)
    .sort(
      (left, right) =>
        (right.generation ?? 0) - (left.generation ?? 0) ||
        right.savedAt.localeCompare(left.savedAt)
    )[0];
  if (!match) return null;
  lastGeneration = Math.max(lastGeneration, match.generation ?? 0);
  return normalizeClientSnapshot(match.snapshot);
};

const replaceCacheSlot = async (path: string, payload: string): Promise<void> => {
  const temporaryPath = `${path}.next`;
  await FileSystem.writeAsStringAsync(temporaryPath, payload);
  const current = await FileSystem.getInfoAsync(path);
  if (current.exists) await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: temporaryPath, to: path });
};

const writePendingSnapshots = async (): Promise<void> => {
  while (pending) {
    const current = pending;
    pending = null;
    lastGeneration = Math.max(lastGeneration + 1, Date.now());
    const payload: CachedSnapshot = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      generation: lastGeneration,
      serverUrl: current.serverUrl,
      savedAt: new Date().toISOString(),
      snapshot: boundedSnapshotForCache(current.snapshot, current.retainedChannelIds),
    };
    const path = cachePaths[lastGeneration % cachePaths.length];
    if (path) await replaceCacheSlot(path, JSON.stringify(payload));
  }
};

const startDrain = (): Promise<void> => {
  if (!drainPromise) {
    drainPromise = writePendingSnapshots().finally(() => {
      drainPromise = null;
      if (pending && !writeTimer) void startDrain().catch(() => undefined);
    });
  }
  return drainPromise;
};

/** Queue only the latest snapshot while a disk write or debounce is outstanding. */
export const scheduleCachedSnapshotSave = (
  serverUrl: string,
  snapshot: ClientSnapshot,
  retainedChannelIds: readonly string[] = []
): void => {
  if (cachePaths.length === 0 || !serverUrl) return;
  pending = { serverUrl, snapshot, retainedChannelIds: [...retainedChannelIds] };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void startDrain().catch(() => undefined);
  }, CACHE_WRITE_DEBOUNCE_MS);
};

export const flushCachedSnapshotWrites = async (): Promise<void> => {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pending) await startDrain();
  if (drainPromise) await drainPromise;
  if (pending) await flushCachedSnapshotWrites();
};

export const saveCachedSnapshot = async (
  serverUrl: string,
  snapshot: ClientSnapshot,
  retainedChannelIds: readonly string[] = []
): Promise<void> => {
  scheduleCachedSnapshotSave(serverUrl, snapshot, retainedChannelIds);
  await flushCachedSnapshotWrites();
};
