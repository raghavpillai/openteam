import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTeamClient } from "../../../packages/client-core/src/client";
import { AgentDataStore } from "@openteam/messaging";
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
      expect(await store.recallMemory(botId, { query: "CONTROL914" })).toContain(`[profile] ${fact}`);
      expect((await client.deleteBotMemory(peerId, saved.memories[0]!.id)).total).toBe(0);
      expect((await client.botMemories(botId)).total).toBe(1);
      expect((await client.deleteBotMemory(botId, saved.memories[0]!.id)).total).toBe(0);
      expect((await client.botMemories(botId)).total).toBe(0);
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
        profileSection: "preserve profile",
        promptSections: {
          memory: { render: "stale saved fact", compactionEpoch: 3 },
          automations: { render: "preserve routines", compactionEpoch: 3 },
        },
      };
      await app.prisma.contextPromptSnapshot.create({
        data: { contextSessionId: context.id, ...cached },
      });
      expect((await client.clearBotMemories(botId)).total).toBe(0);
      // The pinned memory facts are dropped everywhere, so the next turn shows the deletion.
      const unpinned = { profileSection: "preserve profile", promptSections: { automations: { render: "preserve routines", compactionEpoch: 3 } } };
      expect(
        await app.prisma.contextPromptSnapshot.findUnique({
          where: { contextSessionId: context.id },
        })
      ).toMatchObject(unpinned);
      expect(await app.prisma.conversation.findUnique({ where: { botId } })).toEqual(conversation);
      expect(await store.recallMemory(botId, { query: "CONTROL914" })).not.toContain("own saved fact");
      expect(await store.recallMemory(botId, { query: "CONTROL914" })).toContain(
        "[shared_profile via Memory controls fixture] CONTROL914 shared user fact."
      );
      expect((await client.botMemories(peerId)).total).toBe(1);
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
