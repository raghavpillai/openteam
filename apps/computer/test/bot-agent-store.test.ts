import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotAgentStore } from "../src/bot-agent-store";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

const agentId = "7bd0b588-a0c3-48a2-a73d-f250f10ef8cd";
const LIVE_ROOT = "sand-live-conversation-root-v1__";
let root: string | null = null;
let store: BotAgentStore | null = null;

afterEach(async () => {
  await store?.closeAll();
  store = null;
  root = null;
});

const withDb = <T>(path: string, read: (db: Database) => T, readonly = true): T => {
  const db = new Database(path, readonly ? { readonly: true } : undefined);
  try {
    return read(db);
  } finally {
    db.close(false);
  }
};
const blobJson = (db: Database, id: string) =>
  JSON.parse(Buffer.from((db.query("SELECT data FROM blobs WHERE id = ?").get(id) as { data: Uint8Array }).data).toString("utf8"));
const publication = async (dir: string, id: string) =>
  JSON.parse(await readFile(join(dir, "transcript-publish", `${id}.json`), "utf8"));

describe("OpenTeam-compatible agent SQLite stores", () => {
  test("deleting an open agent is idempotent under concurrency, leaves nothing retired, and preserves another agent's retired files", async () => {
    root = await tempDir("openteam-bot-store-delete-");
    const retiredRoot = join(root, "retired");
    store = new BotAgentStore(join(root, "data"), retiredRoot);
    await store.openForWake(agentId);
    const directory = store.agentDirectory(agentId);
    const unrelated = "10000000-0000-4000-8000-000000000001.previous-attempt";
    await mkdir(join(retiredRoot, unrelated), { recursive: true });
    await writeFile(join(retiredRoot, unrelated, "keep"), "another agent's data");
    const results = await Promise.all(Array.from({ length: 20 }, () => store!.deleteAgent(agentId)));
    expect(results.some(Boolean)).toBe(true);
    expect(store.hasLiveHandle(agentId)).toBe(false);
    expect(await stat(directory).catch(() => null)).toBeNull();
    expect(await store.listAgentDirectories()).toEqual([]);
    expect(await readdir(retiredRoot)).toEqual([unrelated]);
    expect(await readFile(join(retiredRoot, unrelated, "keep"), "utf8")).toBe("another agent's data");
    expect(await store.deleteAgent(agentId)).toBeFalse();
  });

  test("first wake leaves shared agent directories writable by the server group", async () => {
    root = await tempDir("openteam-agent-permissions-");
    store = new BotAgentStore(root);
    await store.openForWake(agentId);
    for (const directory of [join(root, "agents"), store.agentDirectory(agentId), join(store.agentDirectory(agentId), "automations")]) {
      expect((await stat(directory)).mode & 0o077).toBe(0o070);
    }
    expect((await stat(join(store.agentDirectory(agentId), "store.db"))).mode & 0o777).toBe(0o644);
  });

  test("closeAll waits for leases, permits their nested work, and rejects new work", async () => {
    root = await tempDir("openteam-bot-handle-shutdown-");
    const leasedStore = new BotAgentStore(root, undefined, { maxOpenAgents: 2, idleCloseMs: 60_000 });
    store = leasedStore;
    let enterLease!: () => void;
    let releaseLease!: () => void;
    const entered = new Promise<void>((resolve) => (enterLease = resolve));
    const release = new Promise<void>((resolve) => (releaseLease = resolve));
    const idleAgentId = "30000000-0000-4000-8000-000000000003";
    await leasedStore.openForWake(idleAgentId);
    const active = leasedStore.withAgentLease(agentId, async () => {
      enterLease();
      await release;
      await leasedStore.writeKv(agentId, "shutdownResult", "finished");
    });
    await entered;
    let shutdownFinished = false;
    const shutdown = leasedStore.closeAll().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBeFalse();
    expect(leasedStore.hasLiveHandle(agentId)).toBeTrue();
    expect(leasedStore.hasLiveHandle(idleAgentId)).toBeFalse();
    releaseLease();
    await Promise.all([active, shutdown]);
    expect(leasedStore.liveAgentIds()).toEqual([]);
    await expect(leasedStore.readKv(agentId, "shutdownResult")).rejects.toThrow("shutting down");
    expect(
      withDb(join(leasedStore.agentDirectory(agentId), "store.db"), (db) => db.query("SELECT value FROM kv WHERE key = ?").get("shutdownResult"))
    ).toEqual({ value: "finished" });
  });

  test("bulk envelope publication is atomic and byte-identical to ordered appends", async () => {
    root = await tempDir("openteam-bot-envelope-bulk-");
    const now = () => 1_788_000_000_000;
    const sequential = new BotAgentStore(join(root, "sequential"), undefined, { now });
    const bulk = new BotAgentStore(join(root, "bulk"), undefined, { now });
    const envelopes = [
      { role: "user", content: "first", eventId: "event-1" },
      { role: "assistant", content: "second", eventId: "event-2" },
      { role: "user", content: "first", eventId: "event-1" },
      { role: "assistant", content: "third", eventId: "event-3" },
    ];
    try {
      const sequentialIds: string[] = [];
      for (const envelope of envelopes) sequentialIds.push(await sequential.appendConversationEnvelope(agentId, envelope));
      await bulk.openForWake(agentId);
      const bulkPath = join(bulk.agentDirectory(agentId), "conversation-blobs.db");
      withDb(bulkPath, (db) => db.exec(`CREATE TRIGGER fail_live_root BEFORE INSERT ON blobs WHEN NEW.id = '${LIVE_ROOT}' BEGIN SELECT RAISE(ABORT, 'forced root failure'); END;`), false);
      await expect(bulk.appendConversationEnvelopes(agentId, envelopes)).rejects.toThrow("forced root failure");
      expect(withDb(bulkPath, (db) => db.query("SELECT count(*) AS count FROM blobs").get())).toEqual({ count: 0 });
      withDb(bulkPath, (db) => db.exec("DROP TRIGGER fail_live_root"), false);

      expect(await bulk.appendConversationEnvelopes(agentId, envelopes)).toEqual(sequentialIds);
      const rootBytes = withDb(bulkPath, (db) => (db.query(`SELECT data FROM blobs WHERE id = '${LIVE_ROOT}'`).get() as { data: Uint8Array }).data.byteLength);
      expect(await bulk.appendConversationEnvelopes(agentId, envelopes)).toEqual(sequentialIds);
      expect(bulk.conversationPublicationMetrics()).toMatchObject({ blobInsertAttempts: 8, rootPublications: 1, rootBytesWritten: rootBytes });

      await Promise.all([sequential.closeAll(), bulk.closeAll()]);
      const all = (path: string) => withDb(path, (db) => db.query("SELECT id, hex(data) AS data FROM blobs ORDER BY id").all());
      expect(all(bulkPath)).toEqual(all(join(sequential.agentDirectory(agentId), "conversation-blobs.db")));
      expect(sequential.conversationPublicationMetrics().rootPublications).toBe(4);
    } finally {
      await Promise.all([sequential.closeAll(), bulk.closeAll()]);
    }
  });

  test("first wake creates WAL stores and plaintext envelopes whose live root survives a reopen", async () => {
    root = await tempDir("openteam-bot-store-");
    store = new BotAgentStore(root);
    await store.initializeAgent(agentId);
    await Promise.all([store.openForWake(agentId), store.openForWake(agentId), store.openForWake(agentId)]);
    await store.appendTranscriptEntry(agentId, "t0u", { role: "user" });
    const blobId = await store.appendConversationEnvelope(agentId, { role: "user", content: "hello" });
    await store.closeAgent(agentId);
    await store.openForWake(agentId);
    const restartedBlobId = await store.appendConversationEnvelope(agentId, { role: "assistant", content: "after restart" });

    const directory = store.agentDirectory(agentId);
    const names = new Set(await readdir(directory));
    for (const expected of ["automations", "conversation-blobs.db-wal", "store.db-wal"]) expect(names.has(expected)).toBeTrue();
    expect(withDb(join(directory, "store.db"), (db) => db.query("SELECT count(*) AS count FROM transcript_entries").get())).toEqual({ count: 1 });
    withDb(join(directory, "conversation-blobs.db"), (blobs) => {
      expect(blobJson(blobs, blobId)).toEqual({ role: "user", content: "hello" });
      expect(blobJson(blobs, LIVE_ROOT).blobIds).toEqual([blobId, restartedBlobId]);
    });
  });

  test("unknown durable agent directories are adopted into the local roster", async () => {
    root = await tempDir("openteam-bot-store-");
    store = new BotAgentStore(join(root, "sand-data"), join(root, "quarantine"));
    await store.initializeAgent(agentId);
    const unknownId = "5ab461fc-b440-488f-9f3c-88fc15d92c46";
    const unknown = store.agentDirectory(unknownId);
    await mkdir(unknown, { recursive: true });
    await writeFile(join(unknown, "profile.json"), '{"name":"Legacy"}\n');
    expect(await store.quarantineUnknownAgents([agentId], 0)).toEqual([]);
    expect(await store.listAgentDirectories()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: unknownId, kind: "agent", name: "Legacy" })])
    );
    expect(await readFile(join(unknown, "profile.json"), "utf8")).toBe('{"name":"Legacy"}\n');
  });

  test("corrupt stores are quarantined and rebuilt while blob recovery finishes pending markers", async () => {
    root = await tempDir("openteam-bot-store-recovery-");
    store = new BotAgentStore(root);
    await store.initializeAgent(agentId);
    await store.openForWake(agentId);
    await store.closeAgent(agentId);
    const directory = store.agentDirectory(agentId);
    await writeFile(join(directory, "store.db"), "not sqlite");
    await writeFile(join(directory, "conversation-blobs.db"), "also not sqlite");
    await store.openForWake(agentId);
    await store.closeAgent(agentId);
    const names = await readdir(directory);
    expect(names.some((name) => name.startsWith("store.db.corrupt-"))).toBeTrue();
    expect(names.some((name) => name.startsWith("conversation-blobs.db.corrupt-"))).toBeTrue();
    expect(names.some((name) => name.endsWith(".intent") || name.endsWith(".pending"))).toBeFalse();
    for (const file of ["store.db", "conversation-blobs.db"]) {
      expect(withDb(join(directory, file), (db) => db.query("PRAGMA quick_check").get())).toEqual({ quick_check: "ok" });
    }
  });

  test("turn metadata, transcript projections, and search indexes rebuild from store.db", async () => {
    root = await tempDir("openteam-bot-projections-");
    store = new BotAgentStore(root);
    await store.initializeAgent(agentId);
    await writeFile(join(store.agentDirectory(agentId), "profile.json"), '{"name":"Indexed Bot","description":"Projection source"}\n');
    for (let index = 0; index < 205; index += 1) await store.recordRequestId(agentId, `request-${index}`);
    await store.recordTurnSettlement(agentId, { turnId: "turn-1", status: "completed" });
    const at = "2026-08-30T10:00:00.000Z";
    await store.appendTranscriptEntry(agentId, "message-1", {
      kind: "message",
      event: { id: "message-1", kind: "message", role: "assistant", content: "Durable searchable answer", at },
    });
    await store.refreshDerivedProjections(agentId);

    const requestIds = JSON.parse((await store.readKv(agentId, "requestIds")) ?? "null") as { ids: string[] };
    expect(requestIds.ids).toHaveLength(200);
    expect([requestIds.ids[0], requestIds.ids.at(-1)]).toEqual(["request-5", "request-204"]);
    expect(JSON.parse((await store.readKv(agentId, "lastTurnSettlement")) ?? "null")).toMatchObject({ turnId: "turn-1", status: "completed" });
    withDb(join(root, "search-index.db"), (index) => {
      expect(index.query("SELECT name, description FROM agents WHERE id = ?").get(agentId)).toEqual({ name: "Indexed Bot", description: "Projection source" });
      expect(index.query("SELECT id, kind, content, occurred_at FROM messages WHERE agent_id = ?").get(agentId)).toEqual({
        id: "message-1",
        kind: "message",
        content: "Durable searchable answer",
        occurred_at: at,
      });
    });
    expect(await publication(root, agentId)).toMatchObject({ version: 1, agentId, entryCount: 1, latestSeq: 1 });
  });
});

test("concurrent transcript refreshes during bot provisioning publish a consistent snapshot", async () => {
  root = await tempDir("openteam-projection-race-");
  const dir = root;
  const raceStore = new BotAgentStore(dir);
  store = raceStore;
  const id = crypto.randomUUID();
  await raceStore.initializeAgent(id);
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => raceStore.refreshDerivedProjections(id)));
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  expect(await publication(dir, id)).toMatchObject({ agentId: id, entryCount: 0, latestSeq: 0 });
  await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      await raceStore.appendTranscriptEntry(id, `message-${index}`, { kind: "message", content: `New conversation message ${index}` });
      await raceStore.refreshDerivedProjections(id);
    })
  );
  const rows = await raceStore.readTranscriptEntries(id);
  expect(await publication(dir, id)).toMatchObject({ entryCount: rows.length, latestSeq: rows.at(-1)?.seq });
  expect(withDb(join(dir, "search-index.db"), (index) => index.query("SELECT count(*) AS count FROM messages WHERE agent_id = ?").get(id))).toEqual({ count: rows.length });
  expect((await readdir(join(dir, "transcript-publish"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
