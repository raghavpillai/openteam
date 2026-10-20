import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTeamClient } from "../../../packages/client-core/src/client";
import { AgentDataStore } from "@openteam/messaging";
import { memoryLogicalId } from "../../../packages/messaging/src/memory-facts";
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
  }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "memory-controls-"));
  const env = {
    DATABASE_URL: databaseUrl!,
    OPENTEAM_WORKSPACE_ROOT: root,
    OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
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
    }
    await run({ app, store, botId, peerId, root, client });
  } finally {
    await store.stopWatching();
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
  "clear invalidates populated main/fork caches, retains the conversation, excludes shared and peer stores",
  async () =>
    fixture(async ({ app, store, botId, peerId, client }) => {
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
  "list shows one entry per fact, and deleting it removes every copy",
  async () =>
    fixture(async ({ app, store, botId, client }) => {
      const fact = "CONTROL914 historical duplicate.";
      await store.writeMemory(botId, { scope: "agent", tier: "profile", fact });
      await store.writeMemory(botId, { scope: "agent", tier: "log", fact: "CONTROL914 log-only fact." });
      // Facts indexed from hand-edited memory files could repeat a line.
      const copy = await app.prisma.memoryFact.findFirstOrThrow({ where: { namespace: `agent:${botId}`, fact } });
      const { id: _id, ...duplicate } = copy;
      await app.prisma.memoryFact.create({ data: { ...duplicate, sourcePath: "log/2026-09.md", tier: "log" } });
      const listed = await client.botMemories(botId);
      expect(listed.total).toBe(2);
      expect(listed.memories.find((memory) => memory.content === fact)?.kind).toBe("profile");
      expect((await client.deleteBotMemory(botId, memoryLogicalId(fact))).total).toBe(1);
      expect(await app.prisma.memoryFact.count({ where: { namespace: `agent:${botId}`, fact } })).toBe(0);
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
    })
);

dbTest(
  "clear covers more than the visible list limit",
  async () =>
    fixture(async ({ app, store, botId, client }) => {
      const contents = Array.from({ length: 1003 }, (_, i) => `CONTROL914 record ${i}.`);
      await app.prisma.memoryFact.createMany({
        data: contents.map((fact, sourceOrdinal) => ({
          namespace: `agent:${botId}`, scope: "agent", tier: "profile", fact, factHash: fact,
          logicalId: memoryLogicalId(fact), sourceOrdinal, origin: "tool", writtenByBotId: botId,
          createdAt: new Date("2026-09-14"),
        })),
      });
      const snapshot = await client.botMemories(botId);
      expect(snapshot.total).toBe(1003);
      expect(snapshot.memories.length).toBe(1000);
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(await store.recallMemory(botId, { query: "CONTROL914", scope: "agent" })).toContain(
        "(0 searched)"
      );
    }),
  30_000
);

dbTest(
  "old memory files on the computer are neither read nor changed",
  async () =>
    fixture(async ({ store, botId, client }) => {
      const directory = join(store.botDirectory(botId), "memory");
      await mkdir(join(directory, "log"), { recursive: true });
      const text = "# About the user\n\n- (2026-09-14) CONTROL914 fact left on disk.\n";
      await writeFile(join(directory, "profile.md"), text);
      await store.startWatching();
      await store.reconcileBot(botId);
      await store.writeMemory(botId, { scope: "agent", tier: "log", fact: "CONTROL914 saved to rows." });
      expect((await client.botMemories(botId)).memories.map((memory) => memory.content)).toEqual([
        "CONTROL914 saved to rows.",
      ]);
      expect(await store.recallMemory(botId, { query: "left on disk" })).toStartWith("No facts");
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      expect(await readFile(join(directory, "profile.md"), "utf8")).toBe(text);
      expect(await readdir(join(directory, "log"))).toEqual([]);
    })
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
    } finally {
      release("NONE");
      await turn;
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
