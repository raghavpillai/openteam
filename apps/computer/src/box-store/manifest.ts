import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface ManifestTombstone {
  path: string;
  deletedAt: string;
}

export interface BoxStoreManifest {
  version: 1;
  revision: number;
  generatedAt: string;
  files: ManifestFile[];
  tombstones?: ManifestTombstone[];
  etag: string;
}

export interface SnapshotSignatureCache {
  version: 1;
  manifestEtag: string;
  signatures: Record<string, string>;
}

export interface BoxStoreDirtyHint {
  all?: boolean;
  sand?: boolean;
  agentIds?: readonly string[];
  sandPaths?: readonly string[];
  workspace?: boolean;
  pi?: boolean;
  chrome?: boolean;
}

export interface BoxStoreSyncMetrics {
  scheduledRequests: number;
  coalescedRequests: number;
  snapshotRuns: number;
  directoriesVisited: number;
  sourceFilesInspected: number;
  sourceFilesRead: number;
  sourceBytesRead: number;
  contentHashes: number;
  signatureReuses: number;
  sqliteVacuums: number;
  repairRoots: number;
  repairDirectoriesVisited: number;
  repairEntriesInspected: number;
}

export const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export const sqliteName = (name: string): boolean =>
  name === "store.db" || name === "conversation-blobs.db";

export const sqliteSidecar = (name: string): boolean =>
  /^(?:store|conversation-blobs)\.db-(?:shm|wal)$/.test(name);

export const temporaryName = (name: string): boolean =>
  name.startsWith(".box-store-part-") || name.startsWith(".box-store-snap-");

export const sqliteRecoveryArtifact = (name: string): boolean =>
  /^(?:store|conversation-blobs)\.db(?:\.corrupt-.*|\.pending|.*\.(?:intent|pending|replacement))$/.test(
    name
  );

export const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "Cache",
  "Code Cache",
  "GPUCache",
]);

export const logicalContains = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}/`);

export const collapseLogicalPrefixes = (prefixes: Iterable<string>): string[] => {
  const sorted = [...new Set(prefixes)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  );
  const collapsed: string[] = [];
  for (const prefix of sorted) {
    if (!collapsed.some((parent) => logicalContains(parent, prefix))) collapsed.push(prefix);
  }
  return collapsed;
};

export const COPY_IN_CRITICAL_BASENAMES = new Set([
  "store.db",
  "conversation-blobs.db",
  "Cookies",
  "Login Data",
  "Web Data",
  "source-map.json",
]);

export const atomicWrite = async (path: string, bytes: Uint8Array, mode = 0o600): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.box-store-part-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export const manifestEtag = (manifest: Omit<BoxStoreManifest, "etag">): string =>
  digest(
    JSON.stringify({
      version: manifest.version,
      revision: manifest.revision,
      generatedAt: manifest.generatedAt,
      files: manifest.files,
      ...(manifest.tombstones ? { tombstones: manifest.tombstones } : {}),
    })
  );
