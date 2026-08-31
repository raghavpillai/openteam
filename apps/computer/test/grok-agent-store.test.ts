import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GrokAgentStore } from "../src/grok-agent-store";

const agentId = "7bd0b588-a0c3-48a2-a73d-f250f10ef8cd";
let root: string | null = null;
let store: GrokAgentStore | null = null;

afterEach(async () => {
  store?.closeAgent(agentId);
  store = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("Grok-compatible agent SQLite stores", () => {
  test("creation exposes exactly profile-external store.db state", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-grok-store-"));
    store = new GrokAgentStore(root);
    await store.initializeAgent(agentId, 1_788_000_000_000);
    const directory = store.agentDirectory(agentId);

    expect(await readdir(directory)).toEqual(["store.db"]);
    expect((await stat(join(directory, "store.db"))).mode & 0o777).toBe(0o644);

    const database = new Database(join(directory, "store.db"));
    try {
      expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(
        database
          .query(
            "SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: "automation_completion_inbox", strict: 1 },
        { name: "blobs", strict: 1 },
        { name: "kv", strict: 1 },
        { name: "transcript_entries", strict: 1 },
      ]);
      const rows = database.query("SELECT key, value FROM kv ORDER BY key").all() as Array<{
        key: string;
        value: string;
      }>;
      expect(rows.map(({ key }) => key)).toEqual(["introductionPending", "metadata", "origin"]);
      const metadata = JSON.parse(Buffer.from(rows[1]!.value, "hex").toString("utf8"));
      expect(metadata).toMatchObject({
        agentId,
        latestRootBlobId: "",
        name: "New Agent",
        mode: "default",
        isRunEverything: false,
        createdAt: 1_788_000_000_000,
      });
    } finally {
      database.close(false);
    }
  });

  test("first wake creates WAL stores, repair keys, snapshots, and plaintext envelopes", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-grok-store-"));
    store = new GrokAgentStore(root);
    await store.initializeAgent(agentId);
    await Promise.all([
      store.openForWake(agentId),
      store.openForWake(agentId),
      store.openForWake(agentId),
    ]);
    await store.setPromptSnapshot(agentId, "agentProfilePromptSnapshot", {
      version: 1,
      compactionEpoch: 0,
    });
    await store.appendTranscriptEntry(agentId, "t0u", { role: "user" });
    const blobId = await store.appendConversationEnvelope(agentId, {
      role: "user",
      content: "hello",
    });
    store.closeAgent(agentId);
    await store.openForWake(agentId);
    const restartedBlobId = await store.appendConversationEnvelope(agentId, {
      role: "assistant",
      content: "after restart",
    });

    const directory = store.agentDirectory(agentId);
    const names = new Set(await readdir(directory));
    for (const expected of [
      "automations",
      "conversation-blobs.db",
      "conversation-blobs.db-shm",
      "conversation-blobs.db-wal",
      "memory",
      "store.db",
      "store.db-shm",
      "store.db-wal",
    ]) {
      expect(names.has(expected)).toBeTrue();
    }

    const primary = new Database(join(directory, "store.db"), { readonly: true });
    const blobs = new Database(join(directory, "conversation-blobs.db"), { readonly: true });
    try {
      expect(blobs.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(primary.query("SELECT count(*) AS count FROM blobs").get()).toEqual({ count: 0 });
      expect(primary.query("SELECT count(*) AS count FROM transcript_entries").get()).toEqual({
        count: 1,
      });
      expect(
        primary
          .query("SELECT key FROM kv WHERE key IN (?, ?, ?) ORDER BY key")
          .all("agentProfilePromptSnapshot", "hiddenEntryRepairVersion", "staleRootCleanupVersion")
      ).toEqual([
        { key: "agentProfilePromptSnapshot" },
        { key: "hiddenEntryRepairVersion" },
        { key: "staleRootCleanupVersion" },
      ]);
      const row = blobs.query("SELECT data FROM blobs WHERE id = ?").get(blobId) as {
        data: Uint8Array;
      };
      expect(JSON.parse(Buffer.from(row.data).toString("utf8"))).toEqual({
        role: "user",
        content: "hello",
      });
      const liveRoot = blobs
        .query("SELECT data FROM blobs WHERE id = 'sand-live-conversation-root-v1__'")
        .get() as { data: Uint8Array };
      expect(JSON.parse(Buffer.from(liveRoot.data).toString("utf8")).blobIds).toEqual([
        blobId,
        restartedBlobId,
      ]);
    } finally {
      primary.close(false);
      blobs.close(false);
    }
  });

  test("unknown durable agent directories are adopted into the local roster", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-grok-store-"));
    const orphanRoot = join(root, "quarantine");
    store = new GrokAgentStore(join(root, "sand-data"), orphanRoot);
    await store.initializeAgent(agentId);
    const unknownId = "5ab461fc-b440-488f-9f3c-88fc15d92c46";
    const unknown = store.agentDirectory(unknownId);
    await mkdir(unknown, { recursive: true });
    await writeFile(join(unknown, "profile.json"), '{"name":"Legacy"}\n');

    expect(await store.quarantineUnknownAgents([agentId], 0)).toEqual([]);
    expect(new Set(await readdir(join(root, "sand-data", "agents")))).toEqual(
      new Set([agentId, unknownId])
    );
    expect(await store.listAgentDirectories()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unknownId, kind: "agent", name: "Legacy" }),
      ])
    );
    expect(await readFile(join(unknown, "profile.json"), "utf8")).toBe('{"name":"Legacy"}\n');
  });

  test("corrupt stores are quarantined and rebuilt while blob recovery finishes pending markers", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-grok-store-recovery-"));
    store = new GrokAgentStore(root);
    await store.initializeAgent(agentId);
    await store.openForWake(agentId);
    store.closeAgent(agentId);
    const directory = store.agentDirectory(agentId);
    await writeFile(join(directory, "store.db"), "not sqlite");
    await writeFile(join(directory, "conversation-blobs.db"), "also not sqlite");

    await store.openForWake(agentId);
    store.closeAgent(agentId);

    const names = await readdir(directory);
    expect(names.some((name) => name.startsWith("store.db.corrupt-"))).toBeTrue();
    expect(names.some((name) => name.startsWith("conversation-blobs.db.corrupt-"))).toBeTrue();
    expect(names.some((name) => name.endsWith(".intent") || name.endsWith(".pending"))).toBeFalse();
    const primary = new Database(join(directory, "store.db"), { readonly: true });
    const blobs = new Database(join(directory, "conversation-blobs.db"), { readonly: true });
    try {
      expect(primary.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(blobs.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(blobs.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      primary.close(false);
      blobs.close(false);
    }
  });

  test("turn metadata, transcript projections, and search indexes rebuild from store.db", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-grok-projections-"));
    store = new GrokAgentStore(root);
    await store.initializeAgent(agentId);
    await writeFile(
      join(store.agentDirectory(agentId), "profile.json"),
      '{"name":"Indexed Bot","description":"Projection source"}\n'
    );
    for (let index = 0; index < 205; index += 1) {
      await store.recordRequestId(agentId, `request-${index}`);
    }
    await store.recordTurnSettlement(agentId, {
      turnId: "turn-1",
      status: "completed",
    });
    await store.appendTranscriptEntry(agentId, "message-1", {
      kind: "message",
      event: {
        id: "message-1",
        kind: "message",
        role: "assistant",
        content: "Durable searchable answer",
        at: "2026-08-30T10:00:00.000Z",
      },
    });
    await store.refreshDerivedProjections(agentId);

    const requestIds = JSON.parse((await store.readKv(agentId, "requestIds")) ?? "null") as {
      ids: string[];
    };
    expect(requestIds.ids).toHaveLength(200);
    expect(requestIds.ids[0]).toBe("request-5");
    expect(requestIds.ids.at(-1)).toBe("request-204");
    expect(JSON.parse((await store.readKv(agentId, "lastTurnSettlement")) ?? "null")).toMatchObject(
      { turnId: "turn-1", status: "completed" }
    );

    const index = new Database(join(root, "search-index.db"), { readonly: true });
    try {
      expect(index.query("SELECT name, description FROM agents WHERE id = ?").get(agentId)).toEqual(
        { name: "Indexed Bot", description: "Projection source" }
      );
      expect(
        index
          .query("SELECT id, kind, content, occurred_at FROM messages WHERE agent_id = ?")
          .get(agentId)
      ).toEqual({
        id: "message-1",
        kind: "message",
        content: "Durable searchable answer",
        occurred_at: "2026-08-30T10:00:00.000Z",
      });
    } finally {
      index.close(false);
    }
    expect(
      JSON.parse(await readFile(join(root, "transcript-publish", `${agentId}.json`), "utf8"))
    ).toMatchObject({ version: 1, agentId, entryCount: 1, latestSeq: 1 });
  });
});
