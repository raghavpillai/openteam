import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredTranscriptEntry, WithAgentStore } from "./types";

export async function refreshDerivedProjections(
  withAgentStore: WithAgentStore,
  readTranscriptEntries: (agentId: string) => Promise<StoredTranscriptEntry[]>,
  agentDirectory: (agentId: string) => string,
  root: string,
  readKv: (agentId: string, key: string) => Promise<string | null>,
  now: () => number,
  agentId: string
): Promise<void> {
  await withAgentStore(agentId, async () => {
    const entries = await readTranscriptEntries(agentId);
    const directory = agentDirectory(agentId);
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

    const indexPath = join(root, "search-index.db");
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

    const publishDirectory = join(root, "transcript-publish");
    await mkdir(publishDirectory, { recursive: true, mode: 0o700 });
    const publishPath = join(publishDirectory, `${agentId}.json`);
    const temporary = `${publishPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: 1,
        agentId,
        revision: Number((await readKv(agentId, "replicaRevision")) ?? 0),
        entryCount: entries.length,
        latestSeq: entries.at(-1)?.seq ?? 0,
        updatedAt: now(),
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, publishPath);
  });
}
