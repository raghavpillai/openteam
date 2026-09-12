import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { copyFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hexJson } from "./encoding";

export const SQLITE_MODE = 0o644;

export const configure = (database: Database): void => {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
  database.exec("PRAGMA foreign_keys=OFF");
};

export const storeSchema = (database: Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      data BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS transcript_entries (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      entry TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS automation_completion_inbox (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      attribution TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_automation_completion_inbox_pending
      ON automation_completion_inbox(seq) WHERE acknowledged = 0;
    CREATE INDEX IF NOT EXISTS idx_transcript_branched
      ON transcript_entries(seq)
      WHERE json_extract(entry, '$.branched') = 1;
    CREATE INDEX IF NOT EXISTS idx_transcript_window
      ON transcript_entries(seq)
      WHERE coalesce(json_extract(entry, '$.kind'), '') != 'tool-call'
        AND coalesce(json_extract(entry, '$.branched'), 0) != 1;
    PRAGMA user_version=0;
  `);
};

export const blobSchema = (database: Database, userVersion = 1): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      data BLOB NOT NULL
    ) STRICT;
    PRAGMA user_version=${userVersion};
  `);
};

export const sqliteStamp = (): string =>
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

export const quickCheck = (database: Database): void => {
  const row = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
  if (!row || !Object.values(row).includes("ok")) throw new Error("sqlite quick_check failed");
};

export const sqliteSidecars = (path: string): string[] => [
  `${path}-wal`,
  `${path}-shm`,
  `${path}-journal`,
];

export const removeSqlite = async (path: string): Promise<void> => {
  await Promise.all(
    [path, ...sqliteSidecars(path)].map((candidate) => rm(candidate, { force: true }))
  );
};

export const quarantineSqlite = async (path: string, destination: string): Promise<void> => {
  try {
    await rename(path, destination);
  } catch {
    await copyFile(path, destination);
    await rm(path, { force: true });
  }
  await Promise.all(
    sqliteSidecars(path).map(async (sidecar) => {
      const suffix = sidecar.slice(path.length);
      await rename(sidecar, `${destination}${suffix}`).catch(() => undefined);
    })
  );
};

export const attachAndSalvage = (
  database: Database,
  source: string,
  statements: readonly string[]
): void => {
  try {
    database.exec(`ATTACH DATABASE '${source.replaceAll("'", "''")}' AS damaged`);
    for (const statement of statements) {
      try {
        database.exec(statement);
      } catch {
        // A corrupt table must not prevent the remaining independently readable rows from recovery.
      }
    }
  } catch {
    // Quarantine is still the durable recovery artifact when SQLite cannot attach the source.
  } finally {
    try {
      database.exec("DETACH DATABASE damaged");
    } catch {
      // The attach may have failed before the alias existed.
    }
  }
};

export function ensureStoreDefaults(database: Database, agentId: string, createdAt: number): void {
  const metadata = {
    agentId,
    latestRootBlobId: "",
    name: "New Agent",
    mode: "default",
    isRunEverything: false,
    createdAt,
    blobEncryptionKey: randomBytes(32).toString("base64"),
  };
  database
    .query("INSERT OR IGNORE INTO kv(key, value) VALUES (?, ?)")
    .run("metadata", hexJson(metadata));
  database.query("INSERT OR IGNORE INTO kv(key, value) VALUES (?, ?)").run("origin", "user");
  database
    .query("INSERT OR IGNORE INTO kv(key, value) VALUES (?, ?)")
    .run("introductionPending", "1");
}

export async function openStoreWithRecovery(
  agentId: string,
  path: string,
  createdAt: number,
  leaveOpen: boolean
): Promise<Database> {
  let database: Database | null = null;
  try {
    database = new Database(path, { create: true });
    configure(database);
    storeSchema(database);
    quickCheck(database);
    ensureStoreDefaults(database, agentId, createdAt);
    return database;
  } catch (error) {
    database?.close(false);
    database = null;
    if (!(await stat(path).catch(() => null))) throw error;
    const quarantine = `${path}.corrupt-${sqliteStamp()}`;
    await quarantineSqlite(path, quarantine);
    const replacement = new Database(path, { create: true });
    try {
      configure(replacement);
      storeSchema(replacement);
      attachAndSalvage(replacement, quarantine, [
        "INSERT OR IGNORE INTO kv SELECT * FROM damaged.kv",
        "INSERT OR IGNORE INTO blobs SELECT * FROM damaged.blobs",
        "INSERT OR IGNORE INTO transcript_entries SELECT * FROM damaged.transcript_entries",
        "INSERT OR IGNORE INTO automation_completion_inbox SELECT * FROM damaged.automation_completion_inbox",
      ]);
      ensureStoreDefaults(replacement, agentId, createdAt);
      quickCheck(replacement);
      return replacement;
    } catch (replacementError) {
      replacement.close(false);
      await removeSqlite(path);
      throw replacementError;
    }
  } finally {
    if (!leaveOpen && database) {
      // initializeAgentStore owns the returned handle and closes it after its checkpoint.
    }
  }
}

export async function pendingBlobRecovery(blobPath: string): Promise<string | null> {
  const directory = dirname(blobPath);
  const base = blobPath.slice(directory.length + 1);
  const markers = (await readdir(directory).catch(() => []))
    .filter(
      (name) =>
        name === `${base}.pending` ||
        (name.startsWith(`${base}.corrupt-`) &&
          (name.endsWith(".intent") || name.endsWith(".pending")))
    )
    .sort();
  const marker = markers.at(-1);
  return marker ? join(directory, marker) : null;
}

export async function finishBlobRecovery(blobPath: string, markerPath: string): Promise<void> {
  const pendingPath = markerPath.endsWith(".intent")
    ? `${markerPath.slice(0, -".intent".length)}.pending`
    : markerPath;
  if (markerPath !== pendingPath) await rename(markerPath, pendingPath);
  const quarantine = pendingPath.endsWith(".pending")
    ? pendingPath.slice(0, -".pending".length)
    : pendingPath;
  const replacementPath = `${quarantine}.replacement`;
  await removeSqlite(replacementPath);
  const replacement = new Database(replacementPath, { create: true });
  try {
    configure(replacement);
    blobSchema(replacement, 2);
    attachAndSalvage(replacement, quarantine, [
      "INSERT OR IGNORE INTO blobs SELECT * FROM damaged.blobs",
    ]);
    quickCheck(replacement);
    replacement.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    replacement.exec("PRAGMA journal_mode=DELETE");
  } finally {
    replacement.close(false);
  }
  await removeSqlite(blobPath);
  await rename(replacementPath, blobPath);
  await rm(pendingPath, { force: true });
}

export async function openBlobStoreWithRecovery(blobPath: string): Promise<Database> {
  const pending = await pendingBlobRecovery(blobPath);
  if (pending) await finishBlobRecovery(blobPath, pending);
  let database: Database | null = null;
  try {
    database = new Database(blobPath, { create: true });
    configure(database);
    blobSchema(database);
    quickCheck(database);
    return database;
  } catch (error) {
    database?.close(false);
    if (!(await stat(blobPath).catch(() => null))) throw error;
    await Promise.all(sqliteSidecars(blobPath).map((sidecar) => rm(sidecar, { force: true })));
    try {
      database = new Database(blobPath, { create: true });
      configure(database);
      blobSchema(database);
      quickCheck(database);
      return database;
    } catch {
      database?.close(false);
    }
    const quarantine = `${blobPath}.corrupt-${sqliteStamp()}`;
    const intent = `${quarantine}.intent`;
    await writeFile(intent, "", { flag: "wx", mode: 0o600 });
    await quarantineSqlite(blobPath, quarantine);
    const pendingPath = `${quarantine}.pending`;
    await rename(intent, pendingPath);
    await finishBlobRecovery(blobPath, pendingPath);
    const recovered = new Database(blobPath, { create: true });
    configure(recovered);
    blobSchema(recovered, 2);
    quickCheck(recovered);
    return recovered;
  }
}
