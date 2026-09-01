import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentDirectoryRecord,
  AgentDirectorySnapshot,
} from "@openbot/contracts/service-protocol";

export type {
  AgentDirectoryRecord,
  AgentDirectorySnapshot,
} from "@openbot/contracts/service-protocol";

const LIVE_ROOT_ID = "sand-live-conversation-root-v1__";
const SQLITE_MODE = 0o644;
const LIVE_ROOT_MAX_BYTES = 8 * 1024 * 1024;

export const GROK_AGENT_STORE_MAX_OPEN_AGENTS = 32;
export const GROK_AGENT_STORE_IDLE_CLOSE_MS = 2 * 60_000;

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

const sqliteStamp = (): string =>
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

const quickCheck = (database: Database): void => {
  const row = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
  if (!row || !Object.values(row).includes("ok")) throw new Error("sqlite quick_check failed");
};

const sqliteSidecars = (path: string): string[] => [
  `${path}-wal`,
  `${path}-shm`,
  `${path}-journal`,
];

const removeSqlite = async (path: string): Promise<void> => {
  await Promise.all(
    [path, ...sqliteSidecars(path)].map((candidate) => rm(candidate, { force: true }))
  );
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

export const AGENT_DIRECTORY_FULL_SCAN_INTERVAL_MS = 5 * 60_000;
const AGENT_DIRECTORY_SCAN_CONCURRENCY = 16;
const AGENT_DIRECTORY_PENDING_BATCH_SIZE = 16;

export interface AgentDirectoryDiscoveryMetrics {
  cacheHits: number;
  fullScans: number;
  incrementalScans: number;
  directoriesInspected: number;
}

export interface StoredTranscriptEntry {
  seq: number;
  id: string;
  entry: Record<string, unknown>;
}

export interface GrokAgentStoreOptions {
  maxOpenAgents?: number;
  idleCloseMs?: number;
  now?: () => number;
}

export interface AgentStoreHandleMetrics {
  openAgents: number;
  openSqliteHandles: number;
  peakOpenAgents: number;
  lruCloses: number;
  idleCloses: number;
}

export interface ConversationPublicationMetrics {
  blobInsertAttempts: number;
  rootPublications: number;
  rootBytesWritten: number;
}

interface OpenAgentStore {
  store: Database;
  blobs: Database;
  recentBlobIds: string[];
  recentBlobIdSet: Set<string>;
  activeUses: number;
  lastUsedAt: number;
  lruSequence: number;
  closeRequested: boolean;
  closed: boolean;
  closeWaiters: Set<() => void>;
}

interface OpeningAgentStore {
  promise: Promise<OpenAgentStore>;
  reservations: number;
  closeRequested: boolean;
}

interface AgentLeaseContext {
  active: boolean;
  agentIds: Set<string>;
}

/**
 * Grok-compatible per-agent SQLite stores. PostgreSQL and Pi remain product
 * projections while these files hold the same durable, content-addressed
 * conversation envelopes and prompt snapshots exposed by the Grok box.
 */
export class GrokAgentStore {
  private readonly root: string;
  private readonly orphanRoot: string;
  private readonly maxOpenAgents: number;
  private readonly idleCloseMs: number;
  private readonly now: () => number;
  private readonly open = new Map<string, OpenAgentStore>();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, OpeningAgentStore>();
  private readonly leaseContext = new AsyncLocalStorage<AgentLeaseContext>();
  private readonly slotWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private reservedOpenSlots = 0;
  private lruSequence = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private drainingSlotWaiters = false;
  private shuttingDown = false;
  private closeAllPromise: Promise<void> | null = null;
  private readonly handleCounters = {
    peakOpenAgents: 0,
    lruCloses: 0,
    idleCloses: 0,
  };
  private readonly publicationCounters: ConversationPublicationMetrics = {
    blobInsertAttempts: 0,
    rootPublications: 0,
    rootBytesWritten: 0,
  };
  private directoryInventory: {
    rootStamp: string;
    records: Map<string, AgentDirectoryRecord>;
    pending: Set<string>;
    agents: AgentDirectoryRecord[];
    revision: string;
    lastFullScanAt: number;
  } | null = null;
  private directoryInventoryRefresh: Promise<AgentDirectorySnapshot> | null = null;
  private readonly directoryDiscoveryMetrics: AgentDirectoryDiscoveryMetrics = {
    cacheHits: 0,
    fullScans: 0,
    incrementalScans: 0,
    directoriesInspected: 0,
  };

  constructor(
    root = process.env.OPENBOT_AGENT_DATA_ROOT ?? "/home/box/agent-data",
    orphanRoot?: string,
    options: GrokAgentStoreOptions = {}
  ) {
    this.root = resolve(root);
    this.orphanRoot = resolve(
      orphanRoot ?? join(dirname(this.root), ".openbot-orphaned-agent-data")
    );
    const configuredMax =
      options.maxOpenAgents ??
      Number(process.env.OPENBOT_MAX_OPEN_AGENT_STORES ?? GROK_AGENT_STORE_MAX_OPEN_AGENTS);
    const configuredIdleMs =
      options.idleCloseMs ??
      Number(process.env.OPENBOT_AGENT_STORE_IDLE_CLOSE_MS ?? GROK_AGENT_STORE_IDLE_CLOSE_MS);
    if (!Number.isFinite(configuredMax) || configuredMax < 1) {
      throw new Error("max open agent stores must be a positive number");
    }
    if (!Number.isFinite(configuredIdleMs) || configuredIdleMs < 0) {
      throw new Error("agent store idle close interval must be non-negative");
    }
    this.maxOpenAgents = Math.max(1, Math.floor(configuredMax));
    this.idleCloseMs = configuredIdleMs;
    this.now = options.now ?? Date.now;
  }

  agentDirectory(agentId: string): string {
    return join(this.root, "agents", safeId(agentId));
  }

  async initializeAgent(agentId: string, createdAt = this.now()): Promise<void> {
    if (this.shuttingDown && !this.opening.has(agentId)) {
      throw new Error("agent store manager is shutting down");
    }
    if (this.open.has(agentId)) return;
    const pending = this.initializing.get(agentId);
    if (pending) return pending;
    const operation = this.initializeAgentStore(agentId, createdAt);
    this.initializing.set(agentId, operation);
    try {
      await operation;
      // A previously incomplete durable directory may now be adoptable. Keep
      // discovery incremental instead of invalidating the entire inventory.
      if (
        this.directoryInventory &&
        (!this.directoryInventory.records.has(agentId) ||
          this.directoryInventory.pending.has(agentId))
      ) {
        this.directoryInventory.pending.add(agentId);
      }
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
    await this.withAgentStore(agentId, () => undefined);
  }

  async withAgentLease<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.withAgentStore(agentId, operation);
  }

  private async withAgentStore<T>(
    agentId: string,
    operation: (state: OpenAgentStore) => T | Promise<T>
  ): Promise<T> {
    safeId(agentId);
    const inherited = this.leaseContext.getStore();
    if (inherited?.active && inherited.agentIds.has(agentId)) {
      const state = this.open.get(agentId);
      if (!state || state.closed) throw new Error(`agent store closed during use: ${agentId}`);
      state.activeUses += 1;
      this.touchState(state);
      const nestedContext: AgentLeaseContext = {
        active: true,
        agentIds: new Set(inherited.agentIds),
      };
      try {
        return await this.leaseContext.run(nestedContext, () => operation(state));
      } finally {
        nestedContext.active = false;
        this.releaseAgentStore(agentId, state);
      }
    }

    const state = await this.acquireAgentStore(agentId);
    const context: AgentLeaseContext = {
      active: true,
      agentIds: new Set(inherited?.active ? inherited.agentIds : []),
    };
    context.agentIds.add(agentId);
    try {
      return await this.leaseContext.run(context, () => operation(state));
    } finally {
      context.active = false;
      this.releaseAgentStore(agentId, state);
    }
  }

  private async acquireAgentStore(agentId: string): Promise<OpenAgentStore> {
    if (this.shuttingDown) throw new Error("agent store manager is shutting down");
    const current = this.open.get(agentId);
    if (current && !current.closeRequested && !current.closed) {
      current.activeUses += 1;
      this.touchState(current);
      return current;
    }
    if (current?.closeRequested && !current.closed) {
      await this.waitForStateClose(current);
      return this.acquireAgentStore(agentId);
    }

    let opening = this.opening.get(agentId);
    if (!opening) {
      opening = {
        promise: this.openAgentForWake(agentId),
        reservations: 0,
        closeRequested: false,
      };
      this.opening.set(agentId, opening);
    }
    opening.reservations += 1;
    try {
      const state = await opening.promise;
      if (opening.closeRequested) state.closeRequested = true;
      state.activeUses += 1;
      this.touchState(state);
      return state;
    } finally {
      opening.reservations -= 1;
      if (opening.reservations === 0 && this.opening.get(agentId) === opening) {
        this.opening.delete(agentId);
      }
      const state = this.open.get(agentId);
      if (state?.closeRequested) this.closeStateIfUnused(agentId, state, "requested");
    }
  }

  private releaseAgentStore(agentId: string, state: OpenAgentStore): void {
    if (state.closed) return;
    state.activeUses = Math.max(0, state.activeUses - 1);
    this.touchState(state);
    if (state.closeRequested) this.closeStateIfUnused(agentId, state, "requested");
    this.closeExpiredIdleAgents();
    this.drainSlotWaiters();
    this.scheduleIdleTimer();
  }

  private async openAgentForWake(agentId: string): Promise<OpenAgentStore> {
    await this.reserveOpenSlot();
    let slotReserved = true;
    let store: Database | null = null;
    let blobs: Database | null = null;
    let state: OpenAgentStore | null = null;
    try {
      await this.initializeAgent(agentId);
      const directory = this.agentDirectory(agentId);
      await mkdir(join(directory, "memory"), { recursive: true, mode: 0o755 });
      await mkdir(join(directory, "automations"), { recursive: true, mode: 0o755 });
      const storePath = join(directory, "store.db");
      const blobPath = join(directory, "conversation-blobs.db");
      store = await this.openStoreWithRecovery(agentId, storePath, this.now(), true);
      try {
        blobs = await this.openBlobStoreWithRecovery(blobPath);
      } catch (error) {
        store.close(false);
        store = null;
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
      state = {
        store,
        blobs,
        recentBlobIds,
        recentBlobIdSet: new Set(recentBlobIds),
        activeUses: 0,
        lastUsedAt: this.now(),
        lruSequence: ++this.lruSequence,
        closeRequested: false,
        closed: false,
        closeWaiters: new Set(),
      };
      this.reservedOpenSlots -= 1;
      slotReserved = false;
      this.open.set(agentId, state);
      this.handleCounters.peakOpenAgents = Math.max(
        this.handleCounters.peakOpenAgents,
        this.open.size
      );
      this.setKv(agentId, "hiddenEntryRepairVersion", "1");
      this.setKv(agentId, "staleRootCleanupVersion", "1");
      this.drainSlotWaiters();
      return state;
    } catch (error) {
      if (slotReserved) {
        this.reservedOpenSlots -= 1;
      }
      if (state && this.open.get(agentId) === state) this.open.delete(agentId);
      blobs?.close(false);
      store?.close(false);
      this.drainSlotWaiters();
      throw error;
    }
  }

  private reserveOpenSlot(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("agent store manager is shutting down"));
    }
    this.closeExpiredIdleAgents();
    if (this.open.size + this.reservedOpenSlots >= this.maxOpenAgents) {
      const candidate = this.leastRecentlyUsedIdleState();
      if (candidate) this.closeStateIfUnused(candidate[0], candidate[1], "lru");
    }
    if (this.open.size + this.reservedOpenSlots < this.maxOpenAgents) {
      this.reservedOpenSlots += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({ resolve, reject });
    });
  }

  private drainSlotWaiters(): void {
    if (this.drainingSlotWaiters) return;
    this.drainingSlotWaiters = true;
    try {
      if (this.shuttingDown) {
        const error = new Error("agent store manager is shutting down");
        for (const waiter of this.slotWaiters.splice(0)) waiter.reject(error);
        return;
      }
      while (this.slotWaiters.length > 0) {
        if (this.open.size + this.reservedOpenSlots >= this.maxOpenAgents) {
          const candidate = this.leastRecentlyUsedIdleState();
          if (!candidate) break;
          this.closeStateIfUnused(candidate[0], candidate[1], "lru");
        }
        if (this.open.size + this.reservedOpenSlots >= this.maxOpenAgents) break;
        const waiter = this.slotWaiters.shift();
        if (!waiter) break;
        this.reservedOpenSlots += 1;
        waiter.resolve();
      }
    } finally {
      this.drainingSlotWaiters = false;
    }
  }

  private leastRecentlyUsedIdleState(): [string, OpenAgentStore] | null {
    let candidate: [string, OpenAgentStore] | null = null;
    for (const entry of this.open) {
      const [agentId, state] = entry;
      if (!this.canCloseState(agentId, state)) continue;
      if (!candidate || state.lruSequence < candidate[1].lruSequence) candidate = entry;
    }
    return candidate;
  }

  private touchState(state: OpenAgentStore): void {
    state.lastUsedAt = this.now();
    state.lruSequence = ++this.lruSequence;
  }

  private canCloseState(agentId: string, state: OpenAgentStore): boolean {
    return (
      !state.closed &&
      state.activeUses === 0 &&
      (this.opening.get(agentId)?.reservations ?? 0) === 0
    );
  }

  private closeStateIfUnused(
    agentId: string,
    state: OpenAgentStore,
    reason: "requested" | "lru" | "idle"
  ): boolean {
    if (this.open.get(agentId) !== state || !this.canCloseState(agentId, state)) return false;
    state.closed = true;
    this.open.delete(agentId);
    state.store.close(false);
    state.blobs.close(false);
    if (reason === "lru") this.handleCounters.lruCloses += 1;
    if (reason === "idle") this.handleCounters.idleCloses += 1;
    for (const resolveWaiter of state.closeWaiters) resolveWaiter();
    state.closeWaiters.clear();
    this.drainSlotWaiters();
    return true;
  }

  private waitForStateClose(state: OpenAgentStore): Promise<void> {
    if (state.closed) return Promise.resolve();
    return new Promise((resolveWaiter) => state.closeWaiters.add(resolveWaiter));
  }

  private requestStateClose(agentId: string, state: OpenAgentStore): Promise<void> {
    if (state.closed) return Promise.resolve();
    state.closeRequested = true;
    if (this.closeStateIfUnused(agentId, state, "requested")) return Promise.resolve();
    return this.waitForStateClose(state);
  }

  private closeExpiredIdleAgents(now = this.now()): number {
    let closed = 0;
    for (const [agentId, state] of [...this.open]) {
      if (now - state.lastUsedAt < this.idleCloseMs) continue;
      if (this.closeStateIfUnused(agentId, state, "idle")) closed += 1;
    }
    return closed;
  }

  closeIdleAgents(): number {
    const closed = this.closeExpiredIdleAgents();
    this.scheduleIdleTimer();
    return closed;
  }

  private scheduleIdleTimer(): void {
    if (this.shuttingDown || this.idleTimer || this.open.size === 0) return;
    const now = this.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [agentId, state] of this.open) {
      if (!this.canCloseState(agentId, state)) continue;
      nextExpiry = Math.min(nextExpiry, state.lastUsedAt + this.idleCloseMs);
    }
    if (!Number.isFinite(nextExpiry)) return;
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null;
        this.closeExpiredIdleAgents();
        this.scheduleIdleTimer();
      },
      Math.max(1, nextExpiry - now)
    );
    this.idleTimer.unref?.();
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
    const [id] = await this.appendConversationEnvelopesInternal(agentId, [envelope], true);
    if (!id) throw new Error("conversation envelope was not stored");
    return id;
  }

  /**
   * Stores an ordered envelope batch and publishes the live root once. Existing
   * content IDs are replay-safe: their blobs are repaired if necessary without
   * rewriting an unchanged root.
   */
  async appendConversationEnvelopes(
    agentId: string,
    envelopes: readonly unknown[]
  ): Promise<string[]> {
    return this.appendConversationEnvelopesInternal(agentId, envelopes, false);
  }

  private async appendConversationEnvelopesInternal(
    agentId: string,
    envelopes: readonly unknown[],
    publishWhenUnchanged: boolean
  ): Promise<string[]> {
    if (envelopes.length === 0) return [];
    return this.withAgentStore(agentId, (state) => {
      const nextBlobIds = [...state.recentBlobIds];
      const nextBlobIdSet = new Set(state.recentBlobIdSet);
      const ids: string[] = [];
      let rootChanged = false;
      const publication: { root: Buffer | null } = { root: null };
      const insertBlob = state.blobs.query("INSERT OR IGNORE INTO blobs(id, data) VALUES (?, ?)");
      const publishRoot = state.blobs.query("INSERT OR REPLACE INTO blobs(id, data) VALUES (?, ?)");
      const transaction = state.blobs.transaction(() => {
        for (const envelope of envelopes) {
          const data = Buffer.from(JSON.stringify(envelope), "utf8");
          const id = createHash("sha256").update(data).digest("hex");
          ids.push(id);
          insertBlob.run(id, data);
          if (nextBlobIdSet.has(id)) continue;
          nextBlobIdSet.add(id);
          nextBlobIds.push(id);
          rootChanged = true;
        }
        if (rootChanged || publishWhenUnchanged) {
          publication.root = Buffer.from(
            JSON.stringify({ version: 1, blobIds: nextBlobIds, updatedAt: this.now() }),
            "utf8"
          );
          if (publication.root.byteLength > LIVE_ROOT_MAX_BYTES) {
            throw new Error("conversation root exceeds Grok's 8 MiB publication limit");
          }
        }
        if (publication.root) publishRoot.run(LIVE_ROOT_ID, publication.root);
      });
      transaction();

      if (rootChanged) {
        state.recentBlobIds = nextBlobIds;
        state.recentBlobIdSet = nextBlobIdSet;
      }
      this.publicationCounters.blobInsertAttempts += envelopes.length;
      if (publication.root) {
        this.publicationCounters.rootPublications += 1;
        this.publicationCounters.rootBytesWritten += publication.root.byteLength;
      }
      // This second-database update is idempotent. Replaying a batch repairs the
      // narrow crash window after root publication but before metadata update.
      this.updateMetadata(agentId, {
        latestRootBlobId: Buffer.from(LIVE_ROOT_ID, "utf8").toString("hex"),
      });
      return ids;
    });
  }

  async appendTranscriptEntry(agentId: string, id: string, entry: unknown): Promise<void> {
    await this.withAgentStore(agentId, async (state) => {
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
          : this.now();
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
      this.setKv(
        agentId,
        "replicaRevision",
        String(Number.isSafeInteger(revision) ? revision + 1 : 1)
      );
    });
  }

  async replaceTranscriptEntries(
    agentId: string,
    entries: ReadonlyArray<{ id: string; entry: unknown }>
  ): Promise<void> {
    await this.withAgentStore(agentId, (state) => {
      const database = state.store;
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
          if (!keep.has(row.id))
            database.query("DELETE FROM transcript_entries WHERE id = ?").run(row.id);
        }
      });
      transaction();
    });
  }

  async readTranscriptEntries(
    agentId: string,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<StoredTranscriptEntry[]> {
    return this.withAgentStore(agentId, (state) => {
      const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
      const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 10_000)));
      const rows = state.store
        .query(
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
    });
  }

  async readKv(agentId: string, key: string): Promise<string | null> {
    return this.withAgentStore(agentId, (state) => {
      const row = state.store.query("SELECT value FROM kv WHERE key = ?").get(key) as {
        value: string;
      } | null;
      return row?.value ?? null;
    });
  }

  async writeKv(agentId: string, key: string, value: string): Promise<void> {
    await this.withAgentStore(agentId, () => this.setKv(agentId, key, value));
  }

  async recordRequestId(agentId: string, requestId: string): Promise<void> {
    await this.withAgentStore(agentId, async () => {
      const current = await this.readJsonKv(agentId, "requestIds");
      const ids = Array.isArray(current.ids)
        ? current.ids.filter((id): id is string => typeof id === "string")
        : [];
      this.setKv(
        agentId,
        "requestIds",
        JSON.stringify({ ids: [...ids.filter((id) => id !== requestId), requestId].slice(-200) })
      );
    });
  }

  async recordTurnSettlement(
    agentId: string,
    settlement: { turnId: string; status: string; error?: unknown }
  ): Promise<void> {
    await this.withAgentStore(agentId, () => {
      this.setKv(
        agentId,
        "lastTurnSettlement",
        JSON.stringify({ ...settlement, settledAt: this.now() })
      );
    });
  }

  hasLiveHandle(agentId: string): boolean {
    return this.open.has(agentId) || this.opening.has(agentId) || this.initializing.has(agentId);
  }

  liveAgentIds(): string[] {
    return [...this.open.keys()];
  }

  agentStoreHandleMetrics(): AgentStoreHandleMetrics {
    return {
      openAgents: this.open.size,
      openSqliteHandles: this.open.size * 2,
      ...this.handleCounters,
    };
  }

  conversationPublicationMetrics(): ConversationPublicationMetrics {
    return { ...this.publicationCounters };
  }

  async listAgentDirectories(
    options: { forceRefresh?: boolean; maxAgeMs?: number; now?: number } = {}
  ): Promise<AgentDirectoryRecord[]> {
    const snapshot = await this.agentDirectorySnapshot(options);
    return snapshot.agents.map((record) => ({ ...record, memberIds: [...record.memberIds] }));
  }

  async agentDirectorySnapshot(
    options: { forceRefresh?: boolean; maxAgeMs?: number; now?: number } = {}
  ): Promise<AgentDirectorySnapshot> {
    if (this.directoryInventoryRefresh) return this.directoryInventoryRefresh;
    const operation = this.refreshAgentDirectoryInventory(options);
    this.directoryInventoryRefresh = operation;
    try {
      return await operation;
    } finally {
      if (this.directoryInventoryRefresh === operation) this.directoryInventoryRefresh = null;
    }
  }

  agentDirectoryDiscoveryMetrics(): AgentDirectoryDiscoveryMetrics {
    return { ...this.directoryDiscoveryMetrics };
  }

  private async refreshAgentDirectoryInventory(options: {
    forceRefresh?: boolean;
    maxAgeMs?: number;
    now?: number;
  }): Promise<AgentDirectorySnapshot> {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? AGENT_DIRECTORY_FULL_SCAN_INTERVAL_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error("agent directory inventory max age must be non-negative");
    }
    const agentsRoot = join(this.root, "agents");
    const rootStamp = await this.agentDirectoryRootStamp(agentsRoot);
    const current = this.directoryInventory;
    const fullScan =
      options.forceRefresh === true || !current || now - current.lastFullScanAt >= maxAgeMs;
    const rootChanged = !current || current.rootStamp !== rootStamp;
    if (!fullScan && !rootChanged && current.pending.size === 0) {
      this.directoryDiscoveryMetrics.cacheHits += 1;
      return { agents: current.agents, revision: current.revision };
    }

    const entries =
      fullScan || rootChanged
        ? await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
        : [];
    const ids = new Set(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((id) => {
          try {
            safeId(id);
            return true;
          } catch {
            return false;
          }
        })
    );
    const records =
      fullScan || !current ? new Map<string, AgentDirectoryRecord>() : new Map(current.records);
    const pending = fullScan || !current ? new Set<string>() : new Set(current.pending);
    if (rootChanged && current) {
      for (const id of records.keys()) {
        if (!ids.has(id)) records.delete(id);
      }
      for (const id of pending) {
        if (!ids.has(id)) pending.delete(id);
      }
    }
    const candidates = fullScan
      ? [...ids]
      : rootChanged
        ? [...ids].filter((id) => !records.has(id) || pending.has(id))
        : [...pending].slice(0, AGENT_DIRECTORY_PENDING_BATCH_SIZE);
    if (!fullScan && !rootChanged) {
      // Remove before inspection so still-incomplete entries are reinserted at
      // the tail and a large recovery set advances round-robin.
      for (const id of candidates) pending.delete(id);
    }

    if (fullScan) this.directoryDiscoveryMetrics.fullScans += 1;
    else this.directoryDiscoveryMetrics.incrementalScans += 1;
    this.directoryDiscoveryMetrics.directoriesInspected += candidates.length;

    let candidateIndex = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(AGENT_DIRECTORY_SCAN_CONCURRENCY, candidates.length) },
        async () => {
          while (candidateIndex < candidates.length) {
            const id = candidates[candidateIndex++];
            if (!id) continue;
            const record = await this.readAgentDirectoryRecord(agentsRoot, id);
            if (record) {
              records.set(id, record);
              // Invalid/in-progress group manifests stay on the tiny retry set
              // so completing group.json is observed on the next poll.
              if (record.kind === "group" && record.memberIds.length === 0) pending.add(id);
              else pending.delete(id);
            } else {
              records.delete(id);
              pending.add(id);
            }
          }
        }
      )
    );

    const agents = [...records.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    );
    const revision = createHash("sha256").update(JSON.stringify(agents)).digest("base64url");
    const afterStamp = await this.agentDirectoryRootStamp(agentsRoot);
    this.directoryInventory = {
      // Force one more incremental pass if the roster changed during this scan.
      rootStamp: afterStamp === rootStamp ? afterStamp : rootStamp,
      records,
      pending,
      agents,
      revision,
      lastFullScanAt: fullScan ? now : (current?.lastFullScanAt ?? now),
    };
    return { agents, revision };
  }

  private async agentDirectoryRootStamp(agentsRoot: string): Promise<string> {
    const stats = await stat(agentsRoot).catch(() => null);
    return stats
      ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
      : "missing";
  }

  private async readAgentDirectoryRecord(
    agentsRoot: string,
    id: string
  ): Promise<AgentDirectoryRecord | null> {
    const directory = join(agentsRoot, id);
    const [
      directoryStats,
      storeStats,
      groupText,
      profileText,
      settingsText,
      memoryStats,
      contents,
    ] = await Promise.all([
      stat(directory).catch(() => null),
      stat(join(directory, "store.db")).catch(() => null),
      readFile(join(directory, "group.json"), "utf8").catch(() => null),
      readFile(join(directory, "profile.json"), "utf8").catch(() => null),
      readFile(join(directory, "settings.json"), "utf8").catch(() => null),
      stat(join(directory, "memory", "profile.md")).catch(() => null),
      readdir(directory).catch(() => []),
    ]);
    if (!directoryStats) return null;
    const hasQuarantinedStore = contents.some((name) => name.startsWith("store.db.corrupt-"));
    if (!storeStats && !profileText && !memoryStats && !hasQuarantinedStore && !groupText)
      return null;
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
    return {
      id,
      kind,
      name:
        typeof profile.name === "string" && profile.name
          ? profile.name
          : kind === "group"
            ? "Group"
            : "New Bot",
      description: typeof profile.description === "string" ? profile.description : "",
      title: typeof profile.title === "string" ? profile.title : "",
      createdAt: Math.floor(
        Math.min(
          directoryStats.birthtimeMs || directoryStats.mtimeMs,
          storeStats?.birthtimeMs || Number.POSITIVE_INFINITY
        )
      ),
      updatedAt: Math.floor(Math.max(directoryStats.mtimeMs, storeStats?.mtimeMs ?? 0)),
      hasStore: storeStats !== null,
      notifyOnAgentUpdates:
        typeof settings.notifyOnAgentUpdates === "boolean" ? settings.notifyOnAgentUpdates : true,
      hiddenFromSidebar:
        typeof settings.hiddenFromSidebar === "boolean" ? settings.hiddenFromSidebar : false,
      memberIds,
    };
  }

  async refreshDerivedProjections(agentId: string): Promise<void> {
    await this.withAgentStore(agentId, async () => {
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
          updatedAt: this.now(),
        })}\n`,
        { mode: 0o600 }
      );
      await rename(temporary, publishPath);
    });
  }

  async setPromptSnapshot(agentId: string, key: string, value: unknown): Promise<void> {
    await this.withAgentStore(agentId, () => this.setKv(agentId, key, JSON.stringify(value)));
  }

  async closeAgent(agentId: string): Promise<void> {
    const opening = this.opening.get(agentId);
    if (opening) {
      opening.closeRequested = true;
      const state = await opening.promise.catch(() => null);
      if (state) await this.requestStateClose(agentId, state);
      return;
    }
    const state = this.open.get(agentId);
    if (!state) return;
    await this.requestStateClose(agentId, state);
  }

  async closeAll(): Promise<void> {
    if (this.closeAllPromise) return this.closeAllPromise;
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const shutdownError = new Error("agent store manager is shutting down");
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(shutdownError);
    for (const opening of this.opening.values()) opening.closeRequested = true;
    for (const [agentId, state] of this.open) {
      state.closeRequested = true;
      this.closeStateIfUnused(agentId, state, "requested");
    }

    const operation = (async () => {
      await Promise.allSettled([
        ...this.initializing.values(),
        ...[...this.opening.values()].map(({ promise }) => promise),
      ]);
      await Promise.all(
        [...this.open].map(([agentId, state]) => this.requestStateClose(agentId, state))
      );
    })();
    this.closeAllPromise = operation;
    return operation;
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
