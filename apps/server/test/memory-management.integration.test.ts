import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTeamClient } from "../../../packages/client-core/src/client";
import { AgentDataStore } from "@openteam/messaging";
import { memoryLogicalId, readMemoryTree } from "../../../packages/messaging/src/memory-files";
import { AppService } from "../src/app-service";
import { clientRoutes } from "../src/routes/client";
import { eventRoutes } from "../src/routes/event";
import { errorResponse } from "../src/http";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;

async function fixture(
  run: (f: {
    app: AppService;
    store: AgentDataStore;
    botId: string;
    peerId: string;
    root: string;
    client: ReturnType<typeof createOpenTeamClient>;
  }) => Promise<void>,
  dreaming = false
) {
  const root = await mkdtemp(join(tmpdir(), "memory-controls-"));
  const env = {
    DATABASE_URL: databaseUrl!,
    OPENTEAM_WORKSPACE_ROOT: root,
    OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
    OPENTEAM_MEMORY_DREAMING: String(dreaming),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let app: AppService;
  try {
    app = new AppService("disabled");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const store = app.agentData;
  const botId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  const client = createOpenTeamClient({
    baseUrl: "http://memory-test.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const context = {
        app,
        request,
        url,
        path: url.pathname.replace("/api/v0/", "/api/"),
        authMode: "disabled" as const,
        authenticatedSessionId: null,
      };
      try {
        return (
          (await clientRoutes(context)) ??
          (await eventRoutes(context)) ??
          new Response("Not found", { status: 404 })
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  });
  try {
    for (const id of [botId, peerId]) {
      await app.prisma.bot.create({
        data: {
          id,
          name: "Memory controls fixture",
          status: "active",
          defaultDirectory: root,
          onboardingStatus: "completed",
          conversation: { create: {} },
        },
      });
      await store.initializeBot(id);
      await mkdir(store.memoryDirectory(id, "agent"), { recursive: true });
    }
    await run({ app, store, botId, peerId, root, client });
  } finally {
    await store.stopWatching();
    await store.stopMemoryLifecycle();
    await app.eventWakeup.stop();
    await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
    await app.prisma.event.deleteMany({ where: { entityId: { in: [botId, peerId] } } });
    await app.prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
    await app.prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

dbTest(
  "client → routes → real AppService uses the same memory as tool save and RecallMemory",
  async () =>
    fixture(async ({ app, store, botId, peerId, client }) => {
      const fact = "CONTROL914 calibration is TOPAZ-6281.";
      expect((await client.botMemories(botId)).memories).toEqual([]);
      await store.writeMemory(botId, { scope: "agent", tier: "profile", fact });
      const saved = await client.botMemories(botId);
      expect(saved.total).toBe(1);
      expect(saved.memories[0]?.content).toBe(fact);
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        fact
      );
      expect((await client.deleteBotMemory(peerId, saved.memories[0]!.id)).total).toBe(0);
      expect((await client.botMemories(botId)).total).toBe(1);
      expect((await client.deleteBotMemory(botId, saved.memories[0]!.id)).total).toBe(0);
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
      expect((await client.deleteBotMemory(botId, saved.memories[0]!.id)).total).toBe(0);
      await expect(client.botMemories("..%2F")).rejects.toMatchObject({ status: 404 });
      await expect(client.deleteBotMemory(botId, "../profile.md")).rejects.toMatchObject({
        status: 400,
      });
      await app.prisma.bot.update({ where: { id: peerId }, data: { status: "archived" } });
      await expect(client.clearBotMemories(peerId)).rejects.toMatchObject({ status: 404 });
    })
);

dbTest(
  "clear invalidates populated main/fork caches, retains episodes and conversation, excludes shared and peer stores",
  async () =>
    fixture(async ({ app, store, botId, peerId, client }) => {
      const pending = [{ ts: 1, user: "Remember the ongoing rehearsal", agent: "Noted" }];
      await app.prisma.bot.update({ where: { id: botId }, data: { episodeTurns: pending } });
      const conversation = await app.prisma.conversation.findUniqueOrThrow({ where: { botId } });
      await store.writeMemory(botId, {
        scope: "agent",
        tier: "profile",
        fact: "CONTROL914 own saved fact.",
      });
      await store.writeMemory(botId, {
        scope: "user",
        tier: "profile",
        fact: "CONTROL914 shared user fact.",
      });
      await store.writeMemory(peerId, {
        scope: "agent",
        tier: "profile",
        fact: "CONTROL914 peer fact.",
      });
      const context = await app.prisma.contextSession.create({
        data: { botId, scope: "fork", scopeId: crypto.randomUUID() },
      });
      const cached = {
        memoryEpoch: 3,
        memoryRender: "stale saved fact",
        memoryHasFacts: true,
        profileSection: "preserve profile",
      };
      await app.prisma.agentPromptSnapshot.upsert({
        where: { botId },
        create: { botId, ...cached },
        update: cached,
      });
      await app.prisma.contextPromptSnapshot.create({
        data: { contextSessionId: context.id, ...cached },
      });
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(await app.prisma.agentPromptSnapshot.findUnique({ where: { botId } })).toMatchObject({
        memoryEpoch: -1,
        memoryRender: "",
        memoryHasFacts: false,
        profileSection: "preserve profile",
      });
      expect(
        await app.prisma.contextPromptSnapshot.findUnique({
          where: { contextSessionId: context.id },
        })
      ).toMatchObject({ memoryEpoch: -1, memoryRender: "", memoryHasFacts: false });
      expect(
        (await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).episodeTurns
      ).toEqual(pending);
      expect(await app.prisma.conversation.findUnique({ where: { botId } })).toEqual(conversation);
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "user" })).toContain(
        "shared user fact"
      );
      expect((await client.botMemories(peerId)).total).toBe(1);
    })
);

dbTest(
  "list and delete include old room copies, remove duplicates, and preserve surrounding Markdown",
  async () =>
    fixture(async ({ store, botId, client }) => {
      const room = await store.resolveMemoryConversation(botId);
      const fact = "CONTROL914 historical duplicate.";
      await store.writeMemory(botId, { scope: "agent", tier: "profile", fact });
      await store.writeMemory(botId, {
        scope: "conversation",
        memoryConversationId: room.id,
        tier: "log",
        fact,
      });
      await store.writeMemory(botId, {
        scope: "conversation",
        memoryConversationId: room.id,
        tier: "profile",
        fact: "CONTROL914 room-only fact.",
      });
      const path = join(store.memoryDirectory(botId, "agent"), "profile.md");
      await writeFile(
        path,
        (await readFile(path, "utf8")) +
          "\nKeep this manual comment.\n- (2026-09-14) " +
          fact +
          "\n"
      );
      const listed = await client.botMemories(botId);
      expect(listed.total).toBe(2);
      expect((await client.deleteBotMemory(botId, memoryLogicalId(fact))).total).toBe(1);
      expect(await readFile(path, "utf8")).toContain("Keep this manual comment.");
      expect(await readMemoryTree(store.memoryDirectory(botId, "agent"))).toHaveLength(0);
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(
        await readMemoryTree(store.memoryDirectory(botId, "conversation", undefined, room.id))
      ).toHaveLength(0);
      expect(
        await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" }, room.id)
      ).toContain("(0 searched)");
    })
);

dbTest(
  "clear covers more than the visible list limit and records dreaming tombstones",
  async () =>
    fixture(async ({ store, botId, client }) => {
      const root = store.memoryDirectory(botId, "agent");
      const contents = Array.from({ length: 1003 }, (_, i) => `CONTROL914 record ${i}.`);
      await writeFile(
        join(root, "profile.md"),
        "# About the user\n" + contents.map((fact) => `- (2026-09-14) ${fact}\n`).join("")
      );
      const snapshot = await client.botMemories(botId);
      expect(snapshot.total).toBe(1003);
      expect(snapshot.memories.length).toBe(1000);
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(
        await readFile(
          join(root, ".dreaming", "tombstones", memoryLogicalId(contents[1002]!) + ".deleted"),
          "utf8"
        )
      ).toBe("");
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
    }, true),
  30_000
);

dbTest(
  "changes produce content-free events across stores; no-op reads and empty clear stay silent",
  async () =>
    fixture(async ({ app, store, botId, client }) => {
      const events = () =>
        app.prisma.event.findMany({
          where: { topic: "memory.changed", entityId: botId },
          orderBy: { sequence: "asc" },
        });
      await store.reconcileBot(botId);
      expect(await events()).toHaveLength(0);
      const workerStore = new AgentDataStore(app.prisma, {
        root: store.root,
        workspaceRoot: store.workspaceRoot,
      });
      await workerStore.writeMemory(botId, {
        scope: "agent",
        tier: "log",
        fact: "CONTROL914 background save.",
      });
      expect(await events()).toHaveLength(1);
      expect((await events())[0]?.payload).toEqual({ botId });
      await store.reconcileBot(botId);
      await client.botMemories(botId);
      expect(await events()).toHaveLength(1);
      await client.clearBotMemories(botId);
      expect(await events()).toHaveLength(2);
      await client.clearBotMemories(botId);
      expect(await events()).toHaveLength(2);
      await workerStore.stopMemoryLifecycle();
    })
);

dbTest(
  "real file watcher publishes manual memory edits, and reopen reads edits even without events",
  async () =>
    fixture(async ({ app, store, botId, client }) => {
      await store.startWatching();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const path = join(store.memoryDirectory(botId, "agent"), "profile.md");
      await writeFile(path, "# Profile\n- (2026-09-14) CONTROL914 manual edit.\n");
      let count = 0;
      for (let i = 0; i < 80 && !count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        count = await app.prisma.event.count({
          where: { topic: "memory.changed", entityId: botId },
        });
      }
      expect(count).toBeGreaterThan(0);
      expect((await client.botMemories(botId)).memories[0]?.content).toBe(
        "CONTROL914 manual edit."
      );
      await store.stopWatching();
      await writeFile(path, "# Profile\n- (2026-09-14) CONTROL914 edit while disconnected.\n");
      expect((await client.botMemories(botId)).memories[0]?.content).toContain("disconnected");
    })
);

dbTest(
  "first-use list and clear migrate database-only memories before deletion, preventing reseeding",
  async () =>
    fixture(async ({ app, store, botId, peerId, client }) => {
      for (const id of [botId, peerId])
        await app.prisma.memoryFact.create({
          data: {
            namespace: `agent:${id}`,
            scope: "agent",
            tier: "profile",
            fact: "CONTROL914 legacy database fact.",
            factHash: "synthetic-legacy-fact",
            writtenByBotId: id,
          },
        });
      expect((await client.botMemories(botId)).memories[0]?.content).toBe(
        "CONTROL914 legacy database fact."
      );
      // The other bot goes straight to clear, without a prior list/turn/migration.
      expect((await client.clearBotMemories(peerId)).total).toBe(0);
      expect(await store.recallMemory(peerId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
      expect((await client.botMemories(peerId)).total).toBe(0);
    })
);

dbTest("automatic learning becomes visible only after inference and commit finish", async () =>
  fixture(async ({ app, store, botId, client }) => {
    let entered!: () => void;
    let release!: (text: string) => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const inference = new Promise<string>((resolve) => (release = resolve));
    const learner = new AgentDataStore(app.prisma, {
      root: store.root,
      workspaceRoot: store.workspaceRoot,
      memoryDreamingEnabled: false,
      memoryInference: async () => {
        entered();
        return inference;
      },
    });
    const turn = learner.recordTurnMemory(botId, {
      user: "CONTROL914 has a lasting calibration setting worth retaining.",
      assistant: "ACK",
    });
    try {
      await started;
      expect((await client.botMemories(botId)).total).toBe(0);
      release("log: CONTROL914 calibration is JADE-8241.");
      await turn;
      expect((await client.botMemories(botId)).memories[0]?.content).toBe(
        "CONTROL914 calibration is JADE-8241."
      );
      expect(await store.recallMemory(botId, { query: "JADE-8241", scope: "agent" })).toContain(
        "[log]"
      );
      expect(
        (await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).episodePending
      ).toBe(1);
    } finally {
      release("NONE");
      await turn;
      await learner.stopMemoryLifecycle();
    }
  })
);

dbTest(
  "a real PostgreSQL commit reaches the portable client over the product SSE stream",
  async () =>
    fixture(async ({ app, store, botId, client }) => {
      await store.reconcileBot(botId);
      await app.eventWakeup.start();
      const cursor =
        (
          await app.prisma.event.findFirst({
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          })
        )?.sequence.toString() ?? "0";
      const controller = new AbortController();
      let opened!: () => void;
      let received!: (value: string | null) => void;
      const open = new Promise<void>((resolve) => (opened = resolve));
      const event = new Promise<string | null>((resolve) => (received = resolve));
      const listen = client.listenForEvents(
        cursor,
        {
          onOpen: opened,
          onEvent: (event) => {
            if (event.topic === "memory.changed") received(event.entityId);
          },
        },
        controller.signal
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await open;
        await store.writeMemory(botId, {
          scope: "agent",
          tier: "profile",
          fact: "CONTROL914 streamed fact.",
        });
        expect(
          await Promise.race([
            event,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("No live memory event")), 3000);
            }),
          ])
        ).toBe(botId);
        expect((await client.botMemories(botId)).memories[0]?.content).toBe(
          "CONTROL914 streamed fact."
        );
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
        await listen;
      }
    })
);
