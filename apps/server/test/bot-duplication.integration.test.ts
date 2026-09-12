import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, RoutineService } from "@openteam/messaging";
import { Effect } from "effect";
import { PgBoss } from "pg-boss";
import { BotService } from "../src/services/bot-service";
import type { AppService } from "../src/app-service";
import { errorResponse } from "../src/http";
import { botRoutes } from "../src/routes/bot";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("Bot duplication with PostgreSQL and real agent files", () => {
  let prisma: ReturnType<typeof createPrismaClient>;
  let boss: PgBoss;
  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl!);
    boss = new PgBoss({ connectionString: databaseUrl!, schema: "duplicate_test_jobs" });
    await boss.start();
    await boss.createQueue("bot-provision");
  });
  afterAll(async () => {
    await boss.stop();
    await prisma.$disconnect();
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "openteam-duplicate-"));
    const workspace = join(directory, "workspace");
    const root = join(directory, "agent-data");
    await mkdir(workspace);
    const source = await prisma.bot.create({
      data: {
        name: "Research ".repeat(10).slice(0, 80),
        title: "Regional research",
        description: "Never send external messages.",
        instructions: "Cite sources.",
        defaultDirectory: workspace,
        notificationsEnabled: false,
        hiddenFromSidebar: true,
        status: "active",
        onboardingStatus: "completed",
        runtimeSessionId: crypto.randomUUID(),
        runtimeSessionPath: join(directory, "old-session.jsonl"),
        episodePending: 3,
        episodeTurns: [{ user: "OLD_CONTEXT_NONCE" }],
        conversation: { create: { continuity: "attached", compactionEpoch: 4 } },
      },
      include: { conversation: true },
    });
    const channel = await prisma.channel.create({
      data: {
        kind: "bot_dm",
        name: source.name,
        directKey: `bot:${source.id}`,
        members: { create: { botId: source.id, ordinal: 0 } },
      },
    });
    const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
    await store.initializeBot(source.id);
    await store.writeBotFiles(source.id, ["settings"]);
    let computerAvailable = true;
    let computerDisconnected = false;
    const computerCalls: string[] = [];
    const service = (queue = boss) =>
      new BotService(
        prisma,
        queue,
        workspace,
        async (path) => {
          computerCalls.push(path);
          if (computerDisconnected) throw new TypeError("fetch failed");
          return new Response(computerAvailable ? null : "offline", {
            status: computerAvailable ? 204 : 503,
          });
        },
        store
      );
    return {
      directory,
      workspace,
      root,
      source,
      channel,
      store,
      service,
      computerCalls,
      offline: () => {
        computerAvailable = false;
      },
      online: () => {
        computerAvailable = true;
        computerDisconnected = false;
      },
      disconnect: () => {
        computerDisconnected = true;
      },
      cleanup: async () => {
        const bots = await prisma.bot.findMany({
          where: { defaultDirectory: workspace },
          select: { id: true },
        });
        await prisma.channel.deleteMany({
          where: { members: { some: { botId: { in: bots.map((bot) => bot.id) } } } },
        });
        await prisma.bot.deleteMany({ where: { defaultDirectory: workspace } });
        await prisma.idempotencyRecord.deleteMany({
          where: { scope: "bot:duplicate", key: { startsWith: source.id } },
        });
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  test("copies settings, avatars, skills and routine configuration with no history or local memory", async () => {
    const f = await fixture();
    let installationId: string | undefined;
    try {
      const sourceDir = f.store.botDirectory(f.source.id);
      await writeFile(
        join(sourceDir, "settings.json"),
        JSON.stringify({
          notifyOnAgentUpdates: false,
          hiddenFromSidebar: true,
          voice: "test-voice",
        })
      );
      const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      await writeFile(join(sourceDir, "avatar.png"), avatarBytes);
      await f.store.setAvatarFromPath(f.source.id, "avatar.png");
      await writeFile(join(f.workspace, "shared.txt"), "SHARED_FILE_MARKER");
      await mkdir(join(sourceDir, "attachments"));
      await writeFile(join(sourceDir, "attachments", "private.txt"), "ATTACHMENT_MARKER");
      await writeFile(join(sourceDir, "store.db"), "OLD_DATABASE_MARKER");
      await writeFile(join(sourceDir, "conversation-blobs.db"), "OLD_CONTEXT_MARKER");
      await f.store.writeMemory(f.source.id, {
        scope: "agent",
        tier: "profile",
        fact: "BOT_LOCAL_MEMORY_MARKER",
      });
      await prisma.channelMessage.create({
        data: {
          channelId: f.channel.id,
          sender: "user",
          content: "OLD_CHAT_MARKER",
          metadata: { attachments: [{ assetId: "old-asset" }] },
        },
      });
      await prisma.contextSession.create({
        data: {
          botId: f.source.id,
          scope: "channel",
          scopeId: f.channel.id,
          compactionEpoch: 4,
          runtimeSessionId: crypto.randomUUID(),
        },
      });
      await prisma.agentPromptSnapshot.create({
        data: {
          botId: f.source.id,
          memoryRender: "FROZEN_MEMORY_MARKER",
          profileSection: "OLD_PROMPT_MARKER",
          memoryEpoch: 4,
          memoryHasFacts: true,
        },
      });
      const group = await prisma.channel.create({
        data: {
          kind: "group",
          name: "Source team",
          members: { create: { botId: f.source.id, ordinal: 0 } },
        },
      });
      const routines = new RoutineService(
        prisma,
        { defaultTimeZone: "UTC", enqueueWake: async () => ({ run: { id: crypto.randomUUID() } }) },
        f.store
      );
      for (const enabled of [true, false]) {
        await routines.mutate(f.source.id, crypto.randomUUID(), null, {
          action: "create",
          name: enabled ? "Enabled annual" : "Paused annual",
          prompt: "Return TEST",
          schedule: "0 0 1 1 *",
          enabled,
          source: "ui",
        });
      }
      const originals = await prisma.routine.findMany({ where: { botId: f.source.id } });
      for (const routine of originals) {
        await prisma.routine.update({
          where: { id: routine.id },
          data: {
            lastRunAt: new Date("2026-01-01T00:00:00Z"),
            runLedger: [
              { id: "old-run", trigger: "manual", startedAt: 1767225600000, status: "ok" },
            ],
          },
        });
        await f.store.writeRoutine(f.source.id, routine.id);
      }
      const skill = await f.store.writeSkill(f.source.id, {
        name: "Shared duplicate skill",
        description: "A shared test skill",
        body: "Return SHARED_SKILL_MARKER",
      });
      const installation = await prisma.pluginInstallation.create({
        data: {
          pluginKey: f.source.id,
          version: "1",
          name: "Test plugin",
          publisher: "test",
          manifest: {},
          enablements: { create: { botId: f.source.id, enabled: true, skillsEnabled: true } },
          connections: {
            create: {
              connectorKey: "test",
              name: "Test",
              transport: "http",
              authType: "none",
              grants: { create: { botId: f.source.id, enabled: false } },
              policies: { create: { botId: f.source.id, toolName: "send", decision: "deny" } },
            },
          },
        },
      });
      installationId = installation.id;
      const before = await readFile(join(sourceDir, "profile.json"), "utf8");
      const duplicate = await Effect.runPromise(
        f.service().duplicate(f.source.id, { clientRequestId: `${f.source.id}:copy` })
      );
      expect(duplicate).toMatchObject({
        name: `${f.source.name.slice(0, 75)} copy`,
        title: f.source.title,
        description: f.source.description,
        instructions: f.source.instructions,
        hasAvatar: true,
        notificationsEnabled: false,
        hiddenFromSidebar: false,
        defaultDirectory: f.workspace,
        onboardingStatus: "completed",
      });
      expect(duplicate.name.length).toBeLessThanOrEqual(80);
      expect(duplicate.id).not.toBe(f.source.id);
      expect(duplicate.conversationId).not.toBe(f.source.conversation!.id);
      const stored = await prisma.bot.findUniqueOrThrow({
        where: { id: duplicate.id },
        include: {
          conversation: true,
          channelMemberships: true,
          routines: { include: { revisions: true, executions: true } },
          pluginEnablements: true,
          pluginConnectionGrants: true,
          pluginToolPolicies: true,
          contextSessions: true,
          promptSnapshot: true,
        },
      });
      expect(stored).toMatchObject({
        namedBy: "app",
        createdAt: f.source.createdAt,
        runtimeSessionId: null,
        runtimeSessionPath: null,
        episodePending: 0,
        episodeTurns: [],
        contextSessions: [],
        promptSnapshot: null,
        conversation: { continuity: "empty", compactionEpoch: 0 },
      });
      expect(stored.channelMemberships.map((entry) => entry.channelId)).toEqual([
        duplicate.dmChannelId,
      ]);
      expect(
        await prisma.channelMember.count({ where: { channelId: group.id, botId: duplicate.id } })
      ).toBe(0);
      expect(
        await prisma.channelMessage.count({ where: { channelId: duplicate.dmChannelId } })
      ).toBe(0);
      expect(await prisma.run.count({ where: { botId: duplicate.id } })).toBe(0);
      expect(await prisma.inboxEvent.count({ where: { botId: duplicate.id } })).toBe(0);
      expect(await prisma.memoryFact.count({ where: { namespace: `agent:${duplicate.id}` } })).toBe(
        0
      );
      const copiedDir = f.store.botDirectory(duplicate.id);
      expect(JSON.parse(await readFile(join(copiedDir, "settings.json"), "utf8"))).toMatchObject({
        notifyOnAgentUpdates: false,
        hiddenFromSidebar: false,
        voice: "test-voice",
      });
      expect(new Uint8Array(await readFile(stored.avatarPath!))).toEqual(avatarBytes);
      expect((await stat(stored.avatarPath!)).ino).not.toBe(
        (await stat(join(sourceDir, "avatar.png"))).ino
      );
      expect(await readdir(copiedDir)).not.toContain("attachments");
      expect(await readdir(copiedDir)).not.toContain("store.db");
      expect(await readdir(copiedDir)).not.toContain("conversation-blobs.db");
      expect(stored.routines).toHaveLength(2);
      expect(stored.routines.map((routine) => routine.enabled).sort()).toEqual([false, true]);
      for (const routine of stored.routines) {
        expect(originals.some((original) => original.id === routine.id)).toBe(false);
        expect(routine.executions).toEqual([]);
        expect(routine.runLedger).toEqual([]);
        expect(routine.revisions).toHaveLength(1);
        expect(
          await readFile(join(copiedDir, "automations", routine.slug, "automation.json"), "utf8")
        ).toBe(
          await readFile(join(sourceDir, "automations", routine.slug, "automation.json"), "utf8")
        );
        expect(
          JSON.parse(
            await readFile(join(copiedDir, "automations", routine.slug, "runs.json"), "utf8")
          )
        ).toEqual([]);
      }
      expect(stored.pluginEnablements).toMatchObject([{ enabled: true, skillsEnabled: true }]);
      expect(stored.pluginConnectionGrants).toMatchObject([{ enabled: false }]);
      expect(stored.pluginToolPolicies).toMatchObject([{ toolName: "send", decision: "deny" }]);
      await prisma.bot.update({ where: { id: duplicate.id }, data: { status: "active" } });
      const context = await f.store.promptContext(duplicate.id);
      expect(context.memoryRender).not.toContain("BOT_LOCAL_MEMORY_MARKER");
      expect(context.memoryRender).not.toContain("FROZEN_MEMORY_MARKER");
      expect(context.skillRender).toContain(skill.slug);
      expect(await readFile(join(f.workspace, "shared.txt"), "utf8")).toBe("SHARED_FILE_MARKER");
      expect(await readFile(join(sourceDir, "profile.json"), "utf8")).toBe(before);
      await writeFile(stored.avatarPath!, new Uint8Array([1, 2, 3]));
      expect(new Uint8Array(await readFile(join(sourceDir, "avatar.png")))).toEqual(avatarBytes);
      await prisma.savedSkill.delete({ where: { id: skill.id } });
    } finally {
      if (installationId) await prisma.pluginInstallation.delete({ where: { id: installationId } });
      await f.cleanup();
    }
  }, 30_000);

  test("concurrent retries and recovery after a computer outage produce one unchanged copy", async () => {
    const f = await fixture();
    try {
      const input = { clientRequestId: `${f.source.id}:retry` };
      f.offline();
      await expect(Effect.runPromise(f.service().duplicate(f.source.id, input))).rejects.toThrow(
        "offline"
      );
      await prisma.bot.update({
        where: { id: f.source.id },
        data: { title: "Changed after first attempt" },
      });
      f.online();
      const results = await Promise.all(
        [1, 2, 3].map(() => Effect.runPromise(f.service().duplicate(f.source.id, input)))
      );
      expect(new Set(results.map((bot) => bot.id)).size).toBe(1);
      expect(results[0]!.title).toBe("Regional research");
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(2);
      await expect(Effect.runPromise(f.service().duplicate(results[0]!.id, input))).rejects.toThrow(
        "different duplicate"
      );
      const concurrent = { clientRequestId: `${f.source.id}:concurrent` };
      const copies = await Promise.all(
        [1, 2].map(() => Effect.runPromise(f.service().duplicate(f.source.id, concurrent)))
      );
      expect(copies[0]!.id).toBe(copies[1]!.id);
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(3);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("queue failure rolls back copied files and records; missing and archived sources are rejected", async () => {
    const f = await fixture();
    try {
      const failingQueue = {
        send: async () => {
          throw new Error("queue unavailable");
        },
      } as unknown as PgBoss;
      const input = { clientRequestId: `${f.source.id}:rollback` };
      await expect(
        Effect.runPromise(f.service(failingQueue).duplicate(f.source.id, input))
      ).rejects.toThrow("queue unavailable");
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(1);
      expect(await readdir(join(f.root, "agents"))).toEqual([f.source.id]);
      expect(
        await prisma.idempotencyRecord.count({
          where: { scope: "bot:duplicate", key: input.clientRequestId },
        })
      ).toBe(0);
      await access(join(f.store.botDirectory(f.source.id), "profile.json"));
      const copy = await Effect.runPromise(f.service().duplicate(f.source.id, input));
      expect(copy.id).not.toBe(f.source.id);
      await expect(
        Effect.runPromise(
          f.service().duplicate(crypto.randomUUID(), { clientRequestId: `${f.source.id}:missing` })
        )
      ).rejects.toThrow("Bot not found");
      await prisma.bot.update({ where: { id: f.source.id }, data: { status: "archived" } });
      await expect(
        Effect.runPromise(
          f.service().duplicate(f.source.id, { clientRequestId: `${f.source.id}:archived` })
        )
      ).rejects.toThrow("Bot not found");
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("long Unicode names keep whole characters and remain editable", async () => {
    const f = await fixture();
    try {
      const name = `${"A".repeat(74)}🚀`;
      await f.store.mutateBotFiles(f.source.id, ["profile"], (tx) =>
        tx.bot.update({ where: { id: f.source.id }, data: { name } })
      );
      const copy = await Effect.runPromise(
        f.service().duplicate(f.source.id, { clientRequestId: `${f.source.id}:unicode` })
      );
      expect(copy.name).toBe(`${"A".repeat(74)} copy`);
      expect(copy.name.length).toBeLessThanOrEqual(80);
      expect(
        JSON.parse(await readFile(join(f.store.botDirectory(copy.id), "profile.json"), "utf8")).name
      ).toBe(copy.name);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("malformed settings use reconciled defaults without preventing duplication", async () => {
    const f = await fixture();
    try {
      const path = join(f.store.botDirectory(f.source.id), "settings.json");
      await writeFile(path, "{broken JSON");
      const copy = await Effect.runPromise(
        f.service().duplicate(f.source.id, { clientRequestId: `${f.source.id}:bad-settings` })
      );
      expect(copy.notificationsEnabled).toBe(true);
      expect(copy.hiddenFromSidebar).toBe(false);
      expect(
        JSON.parse(await readFile(join(f.store.botDirectory(copy.id), "settings.json"), "utf8"))
      ).toEqual({ notifyOnAgentUpdates: true, hiddenFromSidebar: false });
      expect(await readFile(path, "utf8")).toBe("{broken JSON");
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("replaying a deleted duplicate never recreates its computer store", async () => {
    const f = await fixture();
    try {
      const input = { clientRequestId: `${f.source.id}:deleted-copy` };
      const copy = await Effect.runPromise(f.service().duplicate(f.source.id, input));
      await prisma.bot.update({ where: { id: copy.id }, data: { status: "archived" } });
      await f.store.deleteAgentFiles(copy.id);
      const calls = f.computerCalls.length;
      await expect(Effect.runPromise(f.service().duplicate(f.source.id, input))).rejects.toThrow(
        "Duplicated bot no longer exists"
      );
      expect(f.computerCalls).toHaveLength(calls);
      expect(await readdir(join(f.root, "agents"))).toEqual([f.source.id]);
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("invalid source identifiers are rejected as unavailable bots", async () => {
    const f = await fixture();
    try {
      for (const id of ["not-a-uuid", "..", "%2F", ""]) {
        await expect(
          Effect.runPromise(
            f.service().duplicate(id, {
              clientRequestId: `${f.source.id}:invalid-${id}`,
            })
          )
        ).rejects.toThrow("Bot not found");
      }
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(1);
      expect(f.computerCalls).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("the HTTP route validates requests, ignores client configuration, and returns conflict/gone statuses", async () => {
    const f = await fixture();
    const app = { duplicateBot: f.service().duplicate } as unknown as AppService;
    const request = async (body: string, id = f.source.id) => {
      const url = new URL(`http://localhost/api/bots/${id}/duplicate`);
      try {
        return (await botRoutes({
          app,
          url,
          path: url.pathname,
          authMode: "disabled",
          request: new Request(url, {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
          }),
          authenticatedSessionId: null,
        }))!;
      } catch (error) {
        return errorResponse(error);
      }
    };
    try {
      for (const body of [
        "{",
        "{}",
        "null",
        '{"clientRequestId":123}',
        '{"clientRequestId":"short"}',
        JSON.stringify({ clientRequestId: "a".repeat(121) }),
      ]) {
        expect((await request(body)).status).toBe(400);
      }
      const input = {
        clientRequestId: `${f.source.id}:http`,
        name: "Injected title",
        instructions: "Injected instructions",
        status: "archived",
      };
      const response = await request(JSON.stringify(input));
      expect(response.status).toBe(201);
      const copy = await response.json();
      expect(copy.name).toBe(`${f.source.name.slice(0, 75)} copy`);
      expect(copy.instructions).toBe(f.source.instructions);
      expect(copy.status).toBe("provisioning");
      expect((await request(JSON.stringify(input), copy.id)).status).toBe(409);
      expect((await request(JSON.stringify(input), "invalid-id")).status).toBe(404);
      await prisma.bot.update({ where: { id: copy.id }, data: { status: "archived" } });
      expect((await request(JSON.stringify(input))).status).toBe(410);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("a failed source is reusable but its runtime failures, child identities, and deleted routines are not inherited", async () => {
    const f = await fixture();
    try {
      await prisma.bot.update({
        where: { id: f.source.id },
        data: {
          status: "failed",
          onboardingStatus: "failed",
          provisioningError: { message: "SOURCE_FAILURE" },
          dreamingEnabled: true,
          inferenceProvider: "test-provider",
          inferenceModel: "test-model",
        },
      });
      const child = await prisma.bot.create({
        data: {
          name: "Hidden child",
          defaultDirectory: f.workspace,
          status: "active",
          conversation: { create: {} },
          subagentIdentity: {
            create: {
              parentBotId: f.source.id,
              parentRunId: crypto.randomUUID(),
              parentChannelId: f.channel.id,
              launchCallId: crypto.randomUUID(),
              description: "Source child",
              prompt: "SOURCE_CHILD_PROMPT",
              subagentType: "general",
              outputPath: "source-child.txt",
            },
          },
        },
      });
      await expect(
        Effect.runPromise(
          f.service().duplicate(child.id, { clientRequestId: `${f.source.id}:child` })
        )
      ).rejects.toThrow("Bot not found");
      await prisma.routine.create({
        data: {
          botId: f.source.id,
          slug: "deleted-routine",
          name: "Deleted source routine",
          prompt: "Do not copy this routine",
          trigger: { type: "cron", schedule: "0 0 1 1 *" },
          scheduleText: "0 0 1 1 *",
          scheduleKind: "cron",
          cronExpression: "0 0 1 1 *",
          timezone: "UTC",
          enabled: false,
          deletedAt: new Date(),
        },
      });
      const copy = await Effect.runPromise(
        f.service().duplicate(f.source.id, { clientRequestId: `${f.source.id}:failed-source` })
      );
      const stored = await prisma.bot.findUniqueOrThrow({
        where: { id: copy.id },
        include: { parentSubagents: true, subagentIdentity: true, routines: true },
      });
      expect(stored).toMatchObject({
        status: "provisioning",
        onboardingStatus: "completed",
        provisioningError: null,
        dreamingEnabled: true,
        inferenceProvider: "test-provider",
        inferenceModel: "test-model",
        runtimeSessionId: null,
        parentSubagents: [],
        subagentIdentity: null,
        routines: [],
      });
      expect(copy.hasAvatar).toBe(false);
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(3);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("a disconnected computer returns a retryable error and preserves the original snapshot", async () => {
    const f = await fixture();
    try {
      const input = { clientRequestId: `${f.source.id}:disconnect` };
      f.disconnect();
      const result = await Effect.runPromise(
        Effect.either(f.service().duplicate(f.source.id, input))
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: { status: 503, code: "agent_store_unavailable" },
      });
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(2);
      await prisma.bot.update({ where: { id: f.source.id }, data: { status: "archived" } });
      f.online();
      const replay = await Effect.runPromise(f.service().duplicate(f.source.id, input));
      expect(replay.title).toBe(f.source.title);
      expect(await prisma.bot.count({ where: { defaultDirectory: f.workspace } })).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 30_000);
});
