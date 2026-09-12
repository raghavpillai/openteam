import type { Database } from "bun:sqlite";

export interface StoredTranscriptEntry {
  seq: number;
  id: string;
  entry: Record<string, unknown>;
}

export interface BotAgentStoreOptions {
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

export interface OpenAgentStore {
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

export interface OpeningAgentStore {
  promise: Promise<OpenAgentStore>;
  reservations: number;
  closeRequested: boolean;
}

export interface AgentLeaseContext {
  active: boolean;
  agentIds: Set<string>;
}

export type WithAgentStore = <T>(
  agentId: string,
  operation: (state: OpenAgentStore) => T | Promise<T>
) => Promise<T>;
