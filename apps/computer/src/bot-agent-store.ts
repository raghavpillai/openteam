import type {
  AgentDirectoryRecord,
  AgentDirectorySnapshot,
} from "@openteam/contracts/service-protocol";
import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AgentDirectoryInventory,
  type AgentDirectoryDiscoveryMetrics,
} from "./agent-store/directory-inventory";
import { hexJson, LIVE_ROOT_ID, parseHexJson, safeId } from "./agent-store/encoding";
import { refreshDerivedProjections } from "./agent-store/projections";
import {
  appendConversationEnvelopesInternal,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from "./agent-store/records";
import {
  openBlobStoreWithRecovery,
  openStoreWithRecovery,
  SQLITE_MODE,
} from "./agent-store/recovery";
import type {
  AgentLeaseContext,
  AgentStoreHandleMetrics,
  BotAgentStoreOptions,
  ConversationPublicationMetrics,
  OpenAgentStore,
  OpeningAgentStore,
  StoredTranscriptEntry,
} from "./agent-store/types";

export type {
  AgentDirectoryRecord,
  AgentDirectorySnapshot,
} from "@openteam/contracts/service-protocol";
export {
  AGENT_DIRECTORY_FULL_SCAN_INTERVAL_MS,
  type AgentDirectoryDiscoveryMetrics,
} from "./agent-store/directory-inventory";

export {
  type AgentStoreHandleMetrics,
  type BotAgentStoreOptions,
  type ConversationPublicationMetrics,
  type StoredTranscriptEntry,
} from "./agent-store/types";

export const BOT_AGENT_STORE_MAX_OPEN_AGENTS = 32;

export const BOT_AGENT_STORE_IDLE_CLOSE_MS = 2 * 60_000;

// The computer supervisor and server/worker have different UIDs, but share
// the box group. Repair older directories too; mkdir does not change their mode.
const ensureSharedAgentDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o770 });
  const mode = (await stat(directory)).mode & 0o7777;
  if ((mode & 0o070) !== 0o070) await chmod(directory, mode | 0o070);
};

/**
 * OpenTeam-compatible per-agent SQLite stores. PostgreSQL and Pi remain product
 * projections while these files hold the same durable, content-addressed
 * conversation envelopes and prompt snapshots exposed by the bot host.
 */
export class BotAgentStore {
  private readonly directories: AgentDirectoryInventory;

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

  constructor(
    root = process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data",
    orphanRoot?: string,
    options: BotAgentStoreOptions = {}
  ) {
    this.root = resolve(root);
    this.orphanRoot = resolve(
      orphanRoot ?? join(dirname(this.root), ".openteam-orphaned-agent-data")
    );
    const configuredMax =
      options.maxOpenAgents ??
      Number(process.env.OPENTEAM_MAX_OPEN_AGENT_STORES ?? BOT_AGENT_STORE_MAX_OPEN_AGENTS);
    const configuredIdleMs =
      options.idleCloseMs ??
      Number(process.env.OPENTEAM_AGENT_STORE_IDLE_CLOSE_MS ?? BOT_AGENT_STORE_IDLE_CLOSE_MS);
    if (!Number.isFinite(configuredMax) || configuredMax < 1) {
      throw new Error("max open agent stores must be a positive number");
    }
    if (!Number.isFinite(configuredIdleMs) || configuredIdleMs < 0) {
      throw new Error("agent store idle close interval must be non-negative");
    }
    this.maxOpenAgents = Math.max(1, Math.floor(configuredMax));
    this.idleCloseMs = configuredIdleMs;
    this.now = options.now ?? Date.now;

    this.directories = new AgentDirectoryInventory(this.root);
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
      this.directories.markPending(agentId);
    } finally {
      this.initializing.delete(agentId);
    }
  }

  private async initializeAgentStore(agentId: string, createdAt: number): Promise<void> {
    const directory = this.agentDirectory(agentId);
    await ensureSharedAgentDirectory(dirname(directory));
    await ensureSharedAgentDirectory(directory);
    const path = join(directory, "store.db");
    const database = await openStoreWithRecovery(agentId, path, createdAt, false);
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
      await ensureSharedAgentDirectory(join(directory, "memory"));
      await ensureSharedAgentDirectory(join(directory, "automations"));
      const storePath = join(directory, "store.db");
      const blobPath = join(directory, "conversation-blobs.db");
      store = await openStoreWithRecovery(agentId, storePath, this.now(), true);
      try {
        blobs = await openBlobStoreWithRecovery(blobPath);
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
    return appendConversationEnvelopesInternal(
      (id, fn) => this.withAgentStore(id, fn),
      this.now,
      this.publicationCounters,
      (id, update) => this.updateMetadata(id, update),
      agentId,
      envelopes,
      publishWhenUnchanged
    );
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
    return replaceTranscriptEntries((id, fn) => this.withAgentStore(id, fn), agentId, entries);
  }

  async readTranscriptEntries(
    agentId: string,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<StoredTranscriptEntry[]> {
    return readTranscriptEntries((id, fn) => this.withAgentStore(id, fn), agentId, options);
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
    return this.directories.listAgentDirectories(options);
  }

  async agentDirectorySnapshot(
    options: { forceRefresh?: boolean; maxAgeMs?: number; now?: number } = {}
  ): Promise<AgentDirectorySnapshot> {
    return this.directories.agentDirectorySnapshot(options);
  }

  agentDirectoryDiscoveryMetrics(): AgentDirectoryDiscoveryMetrics {
    return this.directories.agentDirectoryDiscoveryMetrics();
  }

  async refreshDerivedProjections(agentId: string): Promise<void> {
    return refreshDerivedProjections(
      (id, fn) => this.withAgentStore(id, fn),
      (id) => this.readTranscriptEntries(id),
      (id) => this.agentDirectory(id),
      this.root,
      (id, key) => this.readKv(id, key),
      this.now,
      agentId
    );
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
    // A durable agent directory is roster authority. Unknown-but-valid
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
