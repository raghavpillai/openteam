import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotAgentStore } from "../src/bot-agent-store";

const agentId = "7bd0b588-a0c3-48a2-a73d-f250f10ef8cd";
let root: string | null = null;
let store: BotAgentStore | null = null;

afterEach(async () => {
  await store?.closeAll();
  store = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("OpenTeam-compatible agent SQLite stores", () => {
  test("bounds idle handles with LRU eviction and deterministic idle close", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-handle-lru-"));
    let now = 1_000;
    store = new BotAgentStore(root, undefined, {
      maxOpenAgents: 2,
      idleCloseMs: 500,
      now: () => now,
    });
    const ids = Array.from(
      { length: 5 },
      (_, index) => `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
    );

    for (const id of ids) await store.openForWake(id);

    expect(store.liveAgentIds()).toEqual(ids.slice(-2));
    expect(store.agentStoreHandleMetrics()).toMatchObject({
      openAgents: 2,
      openSqliteHandles: 4,
      peakOpenAgents: 2,
      lruCloses: 3,
      idleCloses: 0,
    });
    now += 501;
    expect(store.closeIdleAgents()).toBe(2);
    expect(store.agentStoreHandleMetrics()).toMatchObject({
      openAgents: 0,
      openSqliteHandles: 0,
      idleCloses: 2,
    });
  });

  test("queues over-capacity opens and never closes a leased store", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-handle-lease-"));
    store = new BotAgentStore(root, undefined, {
      maxOpenAgents: 1,
      idleCloseMs: 60_000,
    });
    const secondId = "20000000-0000-4000-8000-000000000002";
    let enterLease!: () => void;
    let releaseLease!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enterLease = resolveEntered;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseLease = resolveRelease;
    });
    const leasedStore = store;
    const first = leasedStore.withAgentLease(agentId, async () => {
      enterLease();
      await release;
      await leasedStore.writeKv(agentId, "leaseResult", "durable");
    });
    await entered;

    let secondFinished = false;
    const second = store.writeKv(secondId, "opened", "1").then(() => {
      secondFinished = true;
    });
    let closeFinished = false;
    const closeFirst = store.closeAgent(agentId).then(() => {
      closeFinished = true;
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(secondFinished).toBeFalse();
    expect(closeFinished).toBeFalse();
    expect(store.liveAgentIds()).toEqual([agentId]);
    expect(store.agentStoreHandleMetrics().openAgents).toBe(1);

    releaseLease();
    await Promise.all([first, closeFirst, second]);
    expect(secondFinished).toBeTrue();
    expect(store.liveAgentIds()).toEqual([secondId]);
    expect(await store.readKv(agentId, "leaseResult")).toBe("durable");
    expect(store.agentStoreHandleMetrics().peakOpenAgents).toBe(1);
  });

  test("closeAll waits for leases, permits their nested work, and rejects new work", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-handle-shutdown-"));
    store = new BotAgentStore(root, undefined, {
      maxOpenAgents: 2,
      idleCloseMs: 60_000,
    });
    let enterLease!: () => void;
    let releaseLease!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enterLease = resolveEntered;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseLease = resolveRelease;
    });
    const leasedStore = store;
    const idleAgentId = "30000000-0000-4000-8000-000000000003";
    await leasedStore.openForWake(idleAgentId);
    const active = leasedStore.withAgentLease(agentId, async () => {
      enterLease();
      await release;
      await leasedStore.writeKv(agentId, "shutdownResult", "finished");
    });
    await entered;

    let shutdownFinished = false;
    const shutdown = store.closeAll().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBeFalse();
    expect(store.hasLiveHandle(agentId)).toBeTrue();
    expect(store.hasLiveHandle(idleAgentId)).toBeFalse();
    releaseLease();
    await Promise.all([active, shutdown]);
    expect(shutdownFinished).toBeTrue();
    expect(store.liveAgentIds()).toEqual([]);
    await expect(store.readKv(agentId, "shutdownResult")).rejects.toThrow("shutting down");

    const database = new Database(join(store.agentDirectory(agentId), "store.db"), {
      readonly: true,
    });
    try {
      expect(database.query("SELECT value FROM kv WHERE key = ?").get("shutdownResult")).toEqual({
        value: "finished",
      });
    } finally {
      database.close(false);
    }
  });

  test("bulk envelope publication is atomic and byte-identical to ordered appends", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-envelope-bulk-"));
    const fixedNow = 1_788_000_000_000;
    const sequential = new BotAgentStore(join(root, "sequential"), undefined, {
      now: () => fixedNow,
    });
    const bulk = new BotAgentStore(join(root, "bulk"), undefined, {
      now: () => fixedNow,
    });
    const envelopes = [
      { role: "user", content: "first", eventId: "event-1" },
      { role: "assistant", content: "second", eventId: "event-2" },
      { role: "user", content: "first", eventId: "event-1" },
      { role: "assistant", content: "third", eventId: "event-3" },
    ];

    try {
      const sequentialIds: string[] = [];
      for (const envelope of envelopes) {
        sequentialIds.push(await sequential.appendConversationEnvelope(agentId, envelope));
      }

      await bulk.openForWake(agentId);
      const bulkPath = join(bulk.agentDirectory(agentId), "conversation-blobs.db");
      const failureInjector = new Database(bulkPath);
      try {
        failureInjector.exec(`
          CREATE TRIGGER fail_live_root BEFORE INSERT ON blobs
          WHEN NEW.id = 'sand-live-conversation-root-v1__'
          BEGIN SELECT RAISE(ABORT, 'forced root failure'); END;
        `);
      } finally {
        failureInjector.close(false);
      }
      await expect(bulk.appendConversationEnvelopes(agentId, envelopes)).rejects.toThrow(
        "forced root failure"
      );
      const afterFailure = new Database(bulkPath, { readonly: true });
      try {
        expect(afterFailure.query("SELECT count(*) AS count FROM blobs").get()).toEqual({
          count: 0,
        });
      } finally {
        afterFailure.close(false);
      }
      const removeFailureInjector = new Database(bulkPath);
      try {
        removeFailureInjector.exec("DROP TRIGGER fail_live_root");
      } finally {
        removeFailureInjector.close(false);
      }

      const bulkIds = await bulk.appendConversationEnvelopes(agentId, envelopes);
      expect(bulkIds).toEqual(sequentialIds);
      const rootBeforeReplay = new Database(bulkPath, { readonly: true });
      let replayRoot: Buffer;
      try {
        const row = rootBeforeReplay
          .query("SELECT data FROM blobs WHERE id = 'sand-live-conversation-root-v1__'")
          .get() as { data: Uint8Array };
        replayRoot = Buffer.from(row.data);
      } finally {
        rootBeforeReplay.close(false);
      }
      expect(await bulk.appendConversationEnvelopes(agentId, envelopes)).toEqual(sequentialIds);
      expect(bulk.conversationPublicationMetrics()).toMatchObject({
        blobInsertAttempts: 8,
        rootPublications: 1,
        rootBytesWritten: replayRoot.byteLength,
      });

      await Promise.all([sequential.closeAll(), bulk.closeAll()]);
      const sequentialDb = new Database(
        join(sequential.agentDirectory(agentId), "conversation-blobs.db"),
        { readonly: true }
      );
      const bulkDb = new Database(bulkPath, { readonly: true });
      try {
        const rootQuery = "SELECT hex(data) AS data FROM blobs WHERE id = ?";
        expect(bulkDb.query(rootQuery).get("sand-live-conversation-root-v1__")).toEqual(
          sequentialDb.query(rootQuery).get("sand-live-conversation-root-v1__")
        );
        expect(bulkDb.query("SELECT id, hex(data) AS data FROM blobs ORDER BY id").all()).toEqual(
          sequentialDb.query("SELECT id, hex(data) AS data FROM blobs ORDER BY id").all()
        );
      } finally {
        sequentialDb.close(false);
        bulkDb.close(false);
      }
      expect(sequential.conversationPublicationMetrics().rootPublications).toBe(4);
      expect(sequential.conversationPublicationMetrics().rootBytesWritten).toBeGreaterThan(
        bulk.conversationPublicationMetrics().rootBytesWritten
      );
    } finally {
      await Promise.all([sequential.closeAll(), bulk.closeAll()]);
    }
  });

  test("partial-directory retries remain bounded and rotate through the recovery set", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-pending-inventory-"));
    store = new BotAgentStore(root);
    const ids = Array.from(
      { length: 40 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
    );
    const inventoryStore = store;
    await Promise.all(
      ids.map((id) => mkdir(inventoryStore.agentDirectory(id), { recursive: true }))
    );

    expect(await store.listAgentDirectories({ now: 1_000 })).toEqual([]);
    expect(store.agentDirectoryDiscoveryMetrics().directoriesInspected).toBe(40);
    await store.listAgentDirectories({ now: 1_001 });
    expect(store.agentDirectoryDiscoveryMetrics().directoriesInspected).toBe(56);
    await Promise.all(
      ids.map((id) =>
        writeFile(join(inventoryStore.agentDirectory(id), "profile.json"), '{"name":"Late"}\n')
      )
    );
    expect(await store.listAgentDirectories({ now: 1_002 })).toHaveLength(16);
    expect(store.agentDirectoryDiscoveryMetrics().directoriesInspected).toBe(72);
    expect(await store.listAgentDirectories({ now: 1_003 })).toHaveLength(32);
    expect(store.agentDirectoryDiscoveryMetrics().directoriesInspected).toBe(88);
    expect(await store.listAgentDirectories({ now: 1_004 })).toHaveLength(40);
    expect(store.agentDirectoryDiscoveryMetrics().directoriesInspected).toBe(96);
  });

  test("directory discovery caches steady rosters and incrementally retries partial stores", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-inventory-"));
    store = new BotAgentStore(root);
    const agentsRoot = join(root, "agents");
    const firstDirectory = store.agentDirectory(agentId);
    await mkdir(firstDirectory, { recursive: true });
    await writeFile(join(firstDirectory, "profile.json"), '{"name":"Before"}\n');

    expect((await store.listAgentDirectories({ now: 1_000, maxAgeMs: 1_000 }))[0]?.name).toBe(
      "Before"
    );
    const firstMetrics = store.agentDirectoryDiscoveryMetrics();
    expect(firstMetrics).toMatchObject({ fullScans: 1, directoriesInspected: 1 });

    // Editing a file does not change the parent roster directory. The hot path
    // remains cached, while the bounded full-scan deadline preserves recovery.
    await writeFile(join(firstDirectory, "profile.json"), '{"name":"After"}\n');
    expect((await store.listAgentDirectories({ now: 1_500, maxAgeMs: 1_000 }))[0]?.name).toBe(
      "Before"
    );
    expect((await store.listAgentDirectories({ now: 2_001, maxAgeMs: 1_000 }))[0]?.name).toBe(
      "After"
    );

    const partialId = "5ab461fc-b440-488f-9f3c-88fc15d92c46";
    const partialDirectory = store.agentDirectory(partialId);
    await mkdir(partialDirectory, { recursive: true });
    await utimes(agentsRoot, new Date(3_000), new Date(3_000));
    expect(await store.listAgentDirectories({ now: 2_100, maxAgeMs: 1_000 })).toHaveLength(1);
    await writeFile(join(partialDirectory, "profile.json"), '{"name":"Completed later"}\n');
    expect(await store.listAgentDirectories({ now: 2_200, maxAgeMs: 1_000 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: partialId, name: "Completed later" })])
    );

    expect(store.agentDirectoryDiscoveryMetrics()).toMatchObject({
      cacheHits: 1,
      fullScans: 2,
      incrementalScans: 2,
      directoriesInspected: 4,
    });
  });

  test("creation exposes exactly profile-external store.db state", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-"));
    store = new BotAgentStore(root);
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
      const metadataRow = rows[1];
      if (!metadataRow) throw new Error("metadata row is missing");
      const metadata = JSON.parse(Buffer.from(metadataRow.value, "hex").toString("utf8"));
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
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-"));
    store = new BotAgentStore(root);
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
    await store.closeAgent(agentId);
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
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-"));
    const orphanRoot = join(root, "quarantine");
    store = new BotAgentStore(join(root, "sand-data"), orphanRoot);
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
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-recovery-"));
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
    root = await mkdtemp(join(tmpdir(), "openteam-bot-projections-"));
    store = new BotAgentStore(root);
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
