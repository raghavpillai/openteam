import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, manifestEtag, type BoxStoreManifest } from "./manifest";

export const BLOB_RETENTION_MS = 24 * 60 * 60_000;
const HASH = /^[a-f0-9]{64}$/;

/** All snapshot, restore and collection operations share an OS-backed SQLite
 * write lock, including operations in different processes. Process death releases
 * the lock; there is no PID file or age-based lock stealing. */
export async function withBoxStoreOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".operations-lock.db");
  const lock = new Database(path, { create: true });
  let held = false;
  try {
    await chmod(path, 0o600);
    lock.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); held = true; break; }
      catch (error) {
        if ((error as {code?: string}).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return await operation();
  } finally {
    try { if (held) lock.exec("ROLLBACK"); } finally { lock.close(); }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function manifestReferences(text: string): string[] {
  const manifest = JSON.parse(text) as BoxStoreManifest;
  if (manifest.version !== 1 || !Number.isInteger(manifest.revision) || !Array.isArray(manifest.files) ||
      !manifest.files.every(file => typeof file.sha256 === "string" && HASH.test(file.sha256)) ||
      manifest.etag !== manifestEtag({version: 1, revision: manifest.revision,
        generatedAt: manifest.generatedAt, files: manifest.files,
        ...(manifest.tombstones ? {tombstones: manifest.tombstones} : {})})) {
    throw new Error("Refusing blob collection: invalid manifest");
  }
  return manifest.files.map(file => file.sha256);
}

export interface BlobCollectionResult {
  scanned: number;
  candidates: number;
  candidateBytes: number;
  deleted: number;
  deletedBytes: number;
}

/** Caller must hold withBoxStoreOperation. A blob's age is NOT its retention
 * clock: the clock starts only when a successful scan observes it unreferenced.
 * Every conflict manifest remains a recovery root until explicitly resolved. */
export async function collectBoxStoreBlobsLocked(root: string, now = Date.now()): Promise<BlobCollectionResult> {
  const result: BlobCollectionResult = {scanned: 0, candidates: 0, candidateBytes: 0, deleted: 0, deletedBytes: 0};
  const current = await readOptional(join(root, "manifest.json"));
  if (current === null) return result; // An uninitialized store is not an empty snapshot.
  const references = new Set(manifestReferences(current));
  for (const name of await readdir(root)) {
    if (!/^conflict\.manifest-.*\.json$/.test(name)) continue;
    for (const hash of manifestReferences(await readFile(join(root, name), "utf8"))) references.add(hash);
  }
  const statePath = join(root, ".blob-gc-candidates.json");
  const previousText = await readOptional(statePath);
  const previous = previousText === null ? {version: 1, candidates: {}} : JSON.parse(previousText);
  if (previous.version !== 1 || !previous.candidates || typeof previous.candidates !== "object" || Array.isArray(previous.candidates) ||
      !Object.entries(previous.candidates).every(([hash, at]) => HASH.test(hash) && typeof at === "number" && Number.isFinite(at) && at >= 0)) {
    throw new Error("Refusing blob collection: invalid candidate state");
  }
  const candidates: Record<string, number> = {};
  const blobs = join(root, "blobs");
  for (const entry of await readdir(blobs, {withFileTypes: true})) {
    if (!HASH.test(entry.name) || !entry.isFile()) continue;
    const path = join(blobs, entry.name);
    const info = await lstat(path);
    if (!info.isFile()) continue;
    result.scanned += 1;
    if (references.has(entry.name)) continue;
    const prior = previous.candidates[entry.name] as number | undefined;
    // A reused/recreated blob and a backwards clock both restart the grace period.
    const firstSeen = prior !== undefined && prior <= now && info.mtimeMs <= prior ? prior : now;
    if (now - firstSeen >= BLOB_RETENTION_MS && result.deleted < 5000 && result.deletedBytes < 2 * 1024 ** 3) {
      await unlink(path);
      result.deleted += 1;
      result.deletedBytes += info.size;
    } else {
      candidates[entry.name] = firstSeen;
      result.candidates += 1;
      result.candidateBytes += info.size;
    }
  }
  await atomicWrite(statePath, Buffer.from(JSON.stringify({version: 1, candidates})));
  return result;
}
