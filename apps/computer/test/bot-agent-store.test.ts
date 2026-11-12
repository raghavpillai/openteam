import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  test("concurrent retirement is idempotent and preserves another agent's retired files", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-concurrent-delete-"));
    const retiredRoot = join(root, "retired");
    store = new BotAgentStore(join(root, "data"), retiredRoot);
    await store.openForWake(agentId);
    const unrelated = "10000000-0000-4000-8000-000000000001.previous-attempt";
    await mkdir(join(retiredRoot, unrelated), { recursive: true });
    await writeFile(join(retiredRoot, unrelated, "keep"), "another agent's data");
    const results = await Promise.all(Array.from({ length: 20 }, () => store!.deleteAgent(agentId)));
    expect(results.some(Boolean)).toBe(true);
    expect(store.hasLiveHandle(agentId)).toBe(false);
    expect(await store.listAgentDirectories()).toEqual([]);
    expect(await readdir(retiredRoot)).toEqual([unrelated]);
    expect(await readFile(join(retiredRoot, unrelated, "keep"), "utf8")).toBe("another agent's data");
  });

  test("first wake leaves shared agent directories writable by the server group", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-agent-permissions-"));
    store = new BotAgentStore(root);
    await store.openForWake(agentId);

    for (const directory of [
      join(root, "agents"),
      store.agentDirectory(agentId),
      join(store.agentDirectory(agentId), "automations"),
    ]) {
      expect((await stat(directory)).mode & 0o070).toBe(0o070);
      expect((await stat(directory)).mode & 0o007).toBe(0);
    }
    expect((await stat(join(store.agentDirectory(agentId), "store.db"))).mode & 0o777).toBe(0o644);
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

  test("deleting an agent retires its directory even while its store was open", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-bot-store-delete-"));
    const orphanRoot = join(root, "retired");
    store = new BotAgentStore(join(root, "sand-data"), orphanRoot);
    await store.openForWake(agentId);
    const directory = store.agentDirectory(agentId);
    expect(store.hasLiveHandle(agentId)).toBeTrue();

    expect(await store.deleteAgent(agentId)).toBeTrue();

    expect(store.hasLiveHandle(agentId)).toBeFalse();
    expect(await readdir(join(root, "sand-data", "agents"))).toEqual([]);
    expect(await stat(directory).catch(() => null)).toBeNull();
    expect(await store.listAgentDirectories()).toEqual([]);
    // Nothing is left behind under the retirement root either.
    expect(await readdir(orphanRoot)).toEqual([]);
    expect(await store.deleteAgent(agentId)).toBeFalse();
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

test("concurrent transcript refreshes during bot provisioning publish a consistent snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-projection-race-"));
  const store = new BotAgentStore(root);
  const agentId = crypto.randomUUID();
  try {
    await store.initializeAgent(agentId);
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => store.refreshDerivedProjections(agentId))
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(
      JSON.parse(await readFile(join(root, "transcript-publish", `${agentId}.json`), "utf8"))
    ).toMatchObject({ agentId, entryCount: 0, latestSeq: 0 });

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await store.appendTranscriptEntry(agentId, `message-${index}`, {
          kind: "message",
          content: `New conversation message ${index}`,
        });
        await store.refreshDerivedProjections(agentId);
      })
    );
    const rows = await store.readTranscriptEntries(agentId);
    const publication = JSON.parse(
      await readFile(join(root, "transcript-publish", `${agentId}.json`), "utf8")
    );
    expect(publication.entryCount).toBe(rows.length);
    expect(publication.latestSeq).toBe(rows.at(-1)?.seq);
    const index = new Database(join(root, "search-index.db"), { readonly: true });
    try {
      expect(
        index.query("SELECT count(*) AS count FROM messages WHERE agent_id = ?").get(agentId)
      ).toEqual({ count: rows.length });
    } finally {
      index.close();
    }
    expect(
      (await readdir(join(root, "transcript-publish"))).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
