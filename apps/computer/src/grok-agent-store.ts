import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const LIVE_ROOT_ID = "sand-live-conversation-root-v1__";
const SQLITE_MODE = 0o644;

const safeId = (value: string): string => {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("agent id is not a safe filesystem segment");
  }
  return value;
};

const hexJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("hex");

const parseHexJson = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(Buffer.from(value, "hex").toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const configure = (database: Database): void => {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=NORMAL");
  database.exec("PRAGMA foreign_keys=OFF");
};

const storeSchema = (database: Database): void => {
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

const blobSchema = (database: Database, userVersion = 1): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      data BLOB NOT NULL
    ) STRICT;
    PRAGMA user_version=${userVersion};
  `);
};

const sqliteStamp = (): string => new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

const quickCheck = (database: Database): void => {
  const row = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
  if (!row || !Object.values(row).includes("ok")) throw new Error("sqlite quick_check failed");
};

const sqliteSidecars = (path: string): string[] => [`${path}-wal`, `${path}-shm`, `${path}-journal`];

const removeSqlite = async (path: string): Promise<void> => {
  await Promise.all([path, ...sqliteSidecars(path)].map((candidate) => rm(candidate, { force: true })));
};

const quarantineSqlite = async (path: string, destination: string): Promise<void> => {
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

const attachAndSalvage = (
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

export interface AgentDirectoryRecord {
  id: string;
  kind: "agent" | "group";
  name: string;
  description: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  hasStore: boolean;
  notifyOnAgentUpdates: boolean;
  hiddenFromSidebar: boolean;
  memberIds: string[];
}

export interface StoredTranscriptEntry {
  seq: number;
  id: string;
  entry: Record<string, unknown>;
}

interface OpenAgentStore {
  store: Database;
  blobs: Database;
  recentBlobIds: string[];
}

/**
 * Grok-compatible per-agent SQLite stores. PostgreSQL and Pi remain product
 * projections while these files hold the same durable, content-addressed
 * conversation envelopes and prompt snapshots exposed by the Grok box.
 */
export class GrokAgentStore {
  private readonly root: string;
  private readonly orphanRoot: string;
  private readonly open = new Map<string, OpenAgentStore>();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<void>>();

  constructor(
    root = process.env.OPENBOT_AGENT_DATA_ROOT ?? "/home/box/agent-data",
    orphanRoot?: string
  ) {
    this.root = resolve(root);
    this.orphanRoot = resolve(
      orphanRoot ?? join(dirname(this.root), ".openbot-orphaned-agent-data")
    );
  }

  agentDirectory(agentId: string): string {
    return join(this.root, "agents", safeId(agentId));
  }

  async initializeAgent(agentId: string, createdAt = Date.now()): Promise<void> {
    if (this.open.has(agentId)) return;
    const pending = this.initializing.get(agentId);
    if (pending) return pending;
    const operation = this.initializeAgentStore(agentId, createdAt);
    this.initializing.set(agentId, operation);
    try {
      await operation;
    } finally {
      this.initializing.delete(agentId);
    }
  }

  private async initializeAgentStore(agentId: string, createdAt: number): Promise<void> {
    const directory = this.agentDirectory(agentId);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const path = join(directory, "store.db");
    const database = await this.openStoreWithRecovery(agentId, path, createdAt, false);
    let checkpointed = false;
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      checkpointed = true;
    } finally {
      database.close(false);
      if (checkpointed) {
        await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
      }
      await chmod(path, SQLITE_MODE);
    }
  }

  async openForWake(agentId: string): Promise<void> {
    if (this.open.has(agentId)) return;
    const pending = this.opening.get(agentId);
    if (pending) return pending;
    const operation = this.openAgentForWake(agentId);
    this.opening.set(agentId, operation);
    try {
      await operation;
    } finally {
      this.opening.delete(agentId);
    }
  }

  private async openAgentForWake(agentId: string): Promise<void> {
    await this.initializeAgent(agentId);
    if (this.open.has(agentId)) return;
    const directory = this.agentDirectory(agentId);
    await mkdir(join(directory, "memory"), { recursive: true, mode: 0o755 });
    await mkdir(join(directory, "automations"), { recursive: true, mode: 0o755 });
    const storePath = join(directory, "store.db");
    const blobPath = join(directory, "conversation-blobs.db");
    const store = await this.openStoreWithRecovery(agentId, storePath, Date.now(), true);
    let blobs: Database;
    try {
      blobs = await this.openBlobStoreWithRecovery(blobPath);
    } catch (error) {
      store.close(false);
      throw error;
    }
    await Promise.all([chmod(storePath, SQLITE_MODE), chmod(blobPath, SQLITE_MODE)]);
    const rootRow = blobs.query("SELECT data FROM blobs WHERE id = ?").get(LIVE_ROOT_ID) as {
      data: Uint8Array;
    } | null;
    let recentBlobIds: string[] = [];
    if (rootRow) {
      try {
        const value = JSON.parse(Buffer.from(rootRow.data).toString("utf8")) as {
          blobIds?: unknown;
        };
        if (Array.isArray(value.blobIds)) {
          recentBlobIds = value.blobIds.filter(
            (candidate): candidate is string => typeof candidate === "string"
          );
        }
      } catch {
        recentBlobIds = [];
      }
    }
    this.open.set(agentId, { store, blobs, recentBlobIds });
    this.setKv(agentId, "hiddenEntryRepairVersion", "1");
    this.setKv(agentId, "staleRootCleanupVersion", "1");
  }

  private ensureStoreDefaults(database: Database, agentId: string, createdAt: number): void {
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

  private async openStoreWithRecovery(
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
      this.ensureStoreDefaults(database, agentId, createdAt);
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
        this.ensureStoreDefaults(replacement, agentId, createdAt);
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

  private async pendingBlobRecovery(blobPath: string): Promise<string | null> {
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

  private async finishBlobRecovery(blobPath: string, markerPath: string): Promise<void> {
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

  private async openBlobStoreWithRecovery(blobPath: string): Promise<Database> {
    const pending = await this.pendingBlobRecovery(blobPath);
    if (pending) await this.finishBlobRecovery(blobPath, pending);
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
      await this.finishBlobRecovery(blobPath, pendingPath);
      const recovered = new Database(blobPath, { create: true });
      configure(recovered);
      blobSchema(recovered, 2);
      quickCheck(recovered);
      return recovered;
    }
  }

  async appendConversationEnvelope(agentId: string, envelope: unknown): Promise<string> {
    await this.openForWake(agentId);
    const state = this.open.get(agentId)!;
    const data = Buffer.from(JSON.stringify(envelope), "utf8");
    const id = createHash("sha256").update(data).digest("hex");
    state.blobs.query("INSERT OR IGNORE INTO blobs(id, data) VALUES (?, ?)").run(id, data);
    if (!state.recentBlobIds.includes(id)) state.recentBlobIds.push(id);
    const root = Buffer.from(
      JSON.stringify({ version: 1, blobIds: state.recentBlobIds, updatedAt: Date.now() }),
      "utf8"
    );
    if (root.byteLength > 8 * 1024 * 1024) {
      throw new Error("conversation root exceeds Grok's 8 MiB publication limit");
    }
    state.blobs
      .query("INSERT OR REPLACE INTO blobs(id, data) VALUES (?, ?)")
      .run(LIVE_ROOT_ID, root);
    this.updateMetadata(agentId, {
      latestRootBlobId: Buffer.from(LIVE_ROOT_ID, "utf8").toString("hex"),
    });
    return id;
  }

  async appendTranscriptEntry(agentId: string, id: string, entry: unknown): Promise<void> {
    await this.openForWake(agentId);
    const state = this.open.get(agentId)!;
    const encoded = JSON.stringify(entry);
    const existing = state.store
      .query("SELECT entry FROM transcript_entries WHERE id = ?")
      .get(id) as { entry: string } | null;
    if (existing?.entry === encoded) return;
    state.store
      .query(
        "INSERT INTO transcript_entries(id, entry) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry"
      )
      .run(id, encoded);
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const activity =
      typeof item.at === "string" && Number.isFinite(Date.parse(item.at))
        ? Date.parse(item.at)
        : Date.now();
    const unread = await this.readJsonKv(agentId, "unreadState");
    this.setKv(
      agentId,
      "unreadState",
      JSON.stringify({
        lastActivityAt: Math.max(Number(unread.lastActivityAt ?? 0), activity),
        lastViewedAt: Number(unread.lastViewedAt ?? 0),
        isManuallyUnread: unread.isManuallyUnread === true,
      })
    );
    const revision = Number((await this.readKv(agentId, "replicaRevision")) ?? 0);
    this.setKv(agentId, "replicaRevision", String(Number.isSafeInteger(revision) ? revision + 1 : 1));
  }

  async replaceTranscriptEntries(
    agentId: string,
    entries: ReadonlyArray<{ id: string; entry: unknown }>
  ): Promise<void> {
    await this.openForWake(agentId);
    const database = this.open.get(agentId)!.store;
    const keep = new Set(entries.map(({ id }) => id));
    const transaction = database.transaction(() => {
      for (const { id, entry } of entries) {
        database
          .query(
            "INSERT INTO transcript_entries(id, entry) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry"
          )
          .run(id, JSON.stringify(entry));
      }
      for (const row of database.query("SELECT id FROM transcript_entries").all() as Array<{
        id: string;
      }>) {
        if (!keep.has(row.id)) database.query("DELETE FROM transcript_entries WHERE id = ?").run(row.id);
      }
    });
    transaction();
  }

  async readTranscriptEntries(
    agentId: string,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<StoredTranscriptEntry[]> {
    await this.openForWake(agentId);
    const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 10_000)));
    const rows = this.open
      .get(agentId)!
      .store.query(
        "SELECT seq, id, entry FROM transcript_entries WHERE seq > ? ORDER BY seq ASC LIMIT ?"
      )
      .all(afterSeq, limit) as Array<{ seq: number; id: string; entry: string }>;
    return rows.flatMap((row) => {
      try {
        const entry = JSON.parse(row.entry) as unknown;
        return entry && typeof entry === "object" && !Array.isArray(entry)
          ? [{ seq: row.seq, id: row.id, entry: entry as Record<string, unknown> }]
          : [];
      } catch {
        return [];
      }
    });
  }

  async readKv(agentId: string, key: string): Promise<string | null> {
    await this.openForWake(agentId);
    const row = this.open
      .get(agentId)!
      .store.query("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  async writeKv(agentId: string, key: string, value: string): Promise<void> {
    await this.openForWake(agentId);
    this.setKv(agentId, key, value);
  }

  async recordRequestId(agentId: string, requestId: string): Promise<void> {
    await this.openForWake(agentId);
    const current = await this.readJsonKv(agentId, "requestIds");
    const ids = Array.isArray(current.ids)
      ? current.ids.filter((id): id is string => typeof id === "string")
      : [];
    this.setKv(
      agentId,
      "requestIds",
      JSON.stringify({ ids: [...ids.filter((id) => id !== requestId), requestId].slice(-200) })
    );
  }

  async recordTurnSettlement(
    agentId: string,
    settlement: { turnId: string; status: string; error?: unknown }
  ): Promise<void> {
    await this.openForWake(agentId);
    this.setKv(
      agentId,
      "lastTurnSettlement",
      JSON.stringify({ ...settlement, settledAt: Date.now() })
    );
  }

  hasLiveHandle(agentId: string): boolean {
    return this.open.has(agentId) || this.opening.has(agentId) || this.initializing.has(agentId);
  }

  liveAgentIds(): string[] {
    return [...this.open.keys()];
  }

  async listAgentDirectories(): Promise<AgentDirectoryRecord[]> {
    const agentsRoot = join(this.root, "agents");
    const records: AgentDirectoryRecord[] = [];
    for (const entry of await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      try {
        safeId(id);
      } catch {
        continue;
      }
      const directory = join(agentsRoot, id);
      const [directoryStats, storeStats, groupText, profileText, settingsText, memoryStats, contents] =
        await Promise.all([
          stat(directory),
          stat(join(directory, "store.db")).catch(() => null),
          readFile(join(directory, "group.json"), "utf8").catch(() => null),
          readFile(join(directory, "profile.json"), "utf8").catch(() => null),
          readFile(join(directory, "settings.json"), "utf8").catch(() => null),
          stat(join(directory, "memory", "profile.md")).catch(() => null),
          readdir(directory).catch(() => []),
        ]);
      const hasQuarantinedStore = contents.some((name) => name.startsWith("store.db.corrupt-"));
      if (!storeStats && !profileText && !memoryStats && !hasQuarantinedStore && !groupText) continue;
      let profile: Record<string, unknown> = {};
      if (profileText !== null) {
        try {
          const parsed = JSON.parse(profileText) as unknown;
          if (parsed !== null && typeof parsed === "object") {
            profile = parsed as Record<string, unknown>;
          }
        } catch {
          // A malformed profile is an unopenable session but the durable directory still exists.
        }
      }
      let settings: Record<string, unknown> = {};
      if (settingsText !== null) {
        try {
          const parsed = JSON.parse(settingsText) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            settings = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed-but-present settings are preserved and read as defaults.
        }
      }
      let memberIds: string[] = [];
      if (groupText !== null) {
        try {
          const parsed = JSON.parse(groupText) as { memberIds?: unknown };
          if (Array.isArray(parsed.memberIds)) {
            memberIds = parsed.memberIds
              .filter((memberId): memberId is string => typeof memberId === "string")
              .slice(0, 6);
          }
        } catch {
          // The directory remains visible, but an invalid group cannot be materialized.
        }
      }
      const kind = groupText === null ? "agent" : "group";
      records.push({
        id,
        kind,
        name: typeof profile.name === "string" && profile.name ? profile.name : kind === "group" ? "Group" : "New Bot",
        description: typeof profile.description === "string" ? profile.description : "",
        title: typeof profile.title === "string" ? profile.title : "",
        createdAt: Math.floor(Math.min(directoryStats.birthtimeMs || directoryStats.mtimeMs, storeStats?.birthtimeMs || Number.POSITIVE_INFINITY)),
        updatedAt: Math.floor(Math.max(directoryStats.mtimeMs, storeStats?.mtimeMs ?? 0)),
        hasStore: storeStats !== null,
        notifyOnAgentUpdates:
          typeof settings.notifyOnAgentUpdates === "boolean"
            ? settings.notifyOnAgentUpdates
            : true,
        hiddenFromSidebar:
          typeof settings.hiddenFromSidebar === "boolean" ? settings.hiddenFromSidebar : false,
        memberIds,
      });
    }
    return records.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  async refreshDerivedProjections(agentId: string): Promise<void> {
    await this.openForWake(agentId);
    const entries = await this.readTranscriptEntries(agentId);
    const directory = this.agentDirectory(agentId);
    const profileText = await readFile(join(directory, "profile.json"), "utf8").catch(() => "");
    let profile: Record<string, unknown> = {};
    try {
      const value = JSON.parse(profileText) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        profile = value as Record<string, unknown>;
      }
    } catch {
      profile = {};
    }

    const indexPath = join(this.root, "search-index.db");
    const index = new Database(indexPath, { create: true });
    try {
      index.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
      index.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS messages (
          agent_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_search_messages_agent_seq ON messages(agent_id, seq);
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          path TEXT NOT NULL,
          mime_type TEXT NOT NULL
        ) STRICT;
      `);
      const transaction = index.transaction(() => {
        index
          .query(
            "INSERT INTO agents(id, name, description, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at"
          )
          .run(
            agentId,
            typeof profile.name === "string" && profile.name ? profile.name : "New Bot",
            typeof profile.description === "string" ? profile.description : "",
            Date.now()
          );
        index.query("DELETE FROM messages WHERE agent_id = ?").run(agentId);
        for (const row of entries) {
          const nested =
            row.entry.event &&
            typeof row.entry.event === "object" &&
            !Array.isArray(row.entry.event)
              ? (row.entry.event as Record<string, unknown>)
              : row.entry;
          index
            .query(
              "INSERT INTO messages(agent_id, seq, id, kind, content, occurred_at) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .run(
              agentId,
              row.seq,
              row.id,
              typeof row.entry.kind === "string" ? row.entry.kind : "event",
              typeof nested.content === "string" ? nested.content : "",
              typeof nested.at === "string" ? nested.at : ""
            );
        }
        index
          .query(
            "INSERT INTO meta(key, value) VALUES ('schemaVersion', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          )
          .run();
      });
      transaction();
    } finally {
      index.close(false);
    }

    const publishDirectory = join(this.root, "transcript-publish");
    await mkdir(publishDirectory, { recursive: true, mode: 0o700 });
    const publishPath = join(publishDirectory, `${agentId}.json`);
    const temporary = `${publishPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: 1,
        agentId,
        revision: Number((await this.readKv(agentId, "replicaRevision")) ?? 0),
        entryCount: entries.length,
        latestSeq: entries.at(-1)?.seq ?? 0,
        updatedAt: Date.now(),
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, publishPath);
  }

  async setPromptSnapshot(agentId: string, key: string, value: unknown): Promise<void> {
    await this.openForWake(agentId);
    this.setKv(agentId, key, JSON.stringify(value));
  }

  closeAgent(agentId: string): void {
    const state = this.open.get(agentId);
    if (!state) return;
    state.store.close(false);
    state.blobs.close(false);
    this.open.delete(agentId);
  }

  async quarantineUnknownAgents(
    ownerIds: readonly string[],
    minimumAgeMs = 5 * 60_000
  ): Promise<string[]> {
    ownerIds.forEach(safeId);
    void minimumAgeMs;
    void this.orphanRoot;
    // Grok treats a durable agent directory as roster authority. Unknown-but-valid
    // directories are returned by listAgentDirectories and adopted by the control plane.
    return [];
  }

  private setKv(agentId: string, key: string, value: string): void {
    const state = this.open.get(agentId);
    if (!state) throw new Error(`agent store is not open: ${agentId}`);
    state.store
      .query(
        "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(key, value);
  }

  private async readJsonKv(agentId: string, key: string): Promise<Record<string, unknown>> {
    const value = await this.readKv(agentId, key);
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private updateMetadata(agentId: string, update: Record<string, unknown>): void {
    const state = this.open.get(agentId);
    if (!state) throw new Error(`agent store is not open: ${agentId}`);
    const row = state.store.query("SELECT value FROM kv WHERE key = 'metadata'").get() as {
      value: string;
    } | null;
    const metadata = row ? parseHexJson(row.value) : { agentId };
    this.setKv(agentId, "metadata", hexJson({ ...metadata, ...update }));
  }
}
