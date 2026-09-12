import { createHash } from "node:crypto";
import { LIVE_ROOT_ID } from "./encoding";
import type {
  ConversationPublicationMetrics,
  StoredTranscriptEntry,
  WithAgentStore,
} from "./types";

export const LIVE_ROOT_MAX_BYTES = 8 * 1024 * 1024;

export async function appendConversationEnvelopesInternal(
  withAgentStore: WithAgentStore,
  now: () => number,
  publicationCounters: ConversationPublicationMetrics,
  updateMetadata: (agentId: string, update: Record<string, unknown>) => void,
  agentId: string,
  envelopes: readonly unknown[],
  publishWhenUnchanged: boolean
): Promise<string[]> {
  if (envelopes.length === 0) return [];
  return withAgentStore(agentId, (state) => {
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
          JSON.stringify({ version: 1, blobIds: nextBlobIds, updatedAt: now() }),
          "utf8"
        );
        if (publication.root.byteLength > LIVE_ROOT_MAX_BYTES) {
          throw new Error("conversation root exceeds the 8 MiB publication limit");
        }
      }
      if (publication.root) publishRoot.run(LIVE_ROOT_ID, publication.root);
    });
    transaction();

    if (rootChanged) {
      state.recentBlobIds = nextBlobIds;
      state.recentBlobIdSet = nextBlobIdSet;
    }
    publicationCounters.blobInsertAttempts += envelopes.length;
    if (publication.root) {
      publicationCounters.rootPublications += 1;
      publicationCounters.rootBytesWritten += publication.root.byteLength;
    }
    // This second-database update is idempotent. Replaying a batch repairs the
    // narrow crash window after root publication but before metadata update.
    updateMetadata(agentId, {
      latestRootBlobId: Buffer.from(LIVE_ROOT_ID, "utf8").toString("hex"),
    });
    return ids;
  });
}

export async function replaceTranscriptEntries(
  withAgentStore: WithAgentStore,
  agentId: string,
  entries: ReadonlyArray<{ id: string; entry: unknown }>
): Promise<void> {
  await withAgentStore(agentId, (state) => {
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

export async function readTranscriptEntries(
  withAgentStore: WithAgentStore,
  agentId: string,
  options: { afterSeq?: number; limit?: number } = {}
): Promise<StoredTranscriptEntry[]> {
  return withAgentStore(agentId, (state) => {
    const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 10_000)));
    const rows = state.store
      .query("SELECT seq, id, entry FROM transcript_entries WHERE seq > ? ORDER BY seq ASC LIMIT ?")
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
