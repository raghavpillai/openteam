import type {
  AgentDirectoryRecord,
  AgentDirectorySnapshot,
} from "@openteam/contracts/service-protocol";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeId } from "./encoding";

export const AGENT_DIRECTORY_FULL_SCAN_INTERVAL_MS = 5 * 60_000;

export const AGENT_DIRECTORY_SCAN_CONCURRENCY = 16;

export const AGENT_DIRECTORY_PENDING_BATCH_SIZE = 16;

export interface AgentDirectoryDiscoveryMetrics {
  cacheHits: number;
  fullScans: number;
  incrementalScans: number;
  directoriesInspected: number;
}

export class AgentDirectoryInventory {
  markPending(agentId: string): void {
    if (
      this.directoryInventory &&
      (!this.directoryInventory.records.has(agentId) ||
        this.directoryInventory.pending.has(agentId))
    ) {
      this.directoryInventory.pending.add(agentId);
    }
  }
  constructor(private readonly root: string) {}
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
}
