import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, RoutineService } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { DurableStateService } from "../src/update-state";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

databaseTest("each state tool updates its fixed target and names itself in errors", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "state-tools-"));
  const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
  const skillName = `State fixture ${crypto.randomUUID()}`;
  const routineCalls: unknown[] = [];
  let botId = "";
  let channelId = "";
  try {
    const bot = await prisma.bot.create({
      data: { name: "State tools", status: "active", onboardingStatus: "completed", defaultDirectory: root, conversation: { create: {} } },
      include: { conversation: true },
    });
    botId = bot.id;
    const channel = await prisma.channel.create({
      data: { kind: "bot_dm", name: "main", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } },
    });
    channelId = channel.id;
    await store.initializeBot(botId);
    const run = await prisma.run.create({
      data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "running" },
    });
    const routines = {
      mutateOwner: async (owner: unknown, callId: string, runId: string | null, input: unknown) => {
        routineCalls.push({ owner, callId, runId, input });
        return { target: "routine", folder: "brief", name: "Brief", schedule: "0 8 * * 1-5", enabled: false, next_run_at: null };
      },
    };
    // No live timeline session, so a rename records no wake.
    const timeline = { isTimelineSessionActive: async () => false };
    const state = new DurableStateService(prisma, routines as never, store, timeline as never);
    const service = new InternalToolService(
      prisma, { agentData: store } as never, state, async () => {}, {} as never, {} as never, {} as never, {} as never
    );
    const call = (tool: string, args: unknown, callId: string = crypto.randomUUID()) =>
      Effect.runPromise(service.execute({
        runId: run.id, botId, conversationId: bot.conversation!.id, channelId, deliveryId: null, tool, arguments: args, callId,
      })) as Promise<any>;

    // UpdateRoutine keeps the routine handler's arguments; target and action are the tool's own.
    expect(await call("UpdateRoutine", { action: "pause", id: "brief", target: "memory" }, "routine-call")).toMatchObject({
      target: "routine", folder: "brief", owner: { kind: "bot", id: botId },
    });
    expect(routineCalls).toEqual([{
      owner: { kind: "bot", id: botId }, callId: "routine-call", runId: run.id,
      input: { action: "pause", id: "brief", name: undefined, prompt: undefined, schedule: undefined, trigger: undefined, enabled: undefined },
    }]);

    const skill = await call("UpdateSkill", { action: "write", name: skillName, description: "Use this when testing.", body: "1. Test." });
    expect(skill).toMatchObject({ target: "skill", action: "write", name: skillName, saved: true });
    await expect(call("UpdateSkill", { action: "write", name: skillName, body: "1. Test." })).rejects.toThrow(
      "UpdateSkill write requires description"
    );
    expect(await call("UpdateSkill", { action: "delete", id: skill.id })).toMatchObject({ target: "skill", deleted: true });

    // Profile and settings are one tool; each half is its own idempotent update.
    const profileArgs = { name: "Renamed state bot", title: "Designer", hidden_from_sidebar: true, notify_on_updates: false };
    const profile = await call("UpdateProfile", profileArgs, "profile-call");
    expect(profile).toMatchObject({
      target: "profile", name: "Renamed state bot", title: "Designer", updated: true,
      settings: { target: "settings", hidden_from_sidebar: true, notify_on_updates: false, updated: true },
    });
    expect(await call("UpdateProfile", profileArgs, "profile-call")).toEqual(profile);
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      name: "Renamed state bot", title: "Designer", hiddenFromSidebar: true, notificationsEnabled: false,
    });
    expect(await prisma.idempotencyRecord.count({ where: { scope: `state:${botId}`, key: { in: ["profile-call", "profile-call:settings"] } } })).toBe(2);
    await expect(call("UpdateProfile", { title: "Other" }, "profile-call")).rejects.toThrow(
      "This UpdateProfile call id was already used with different arguments"
    );
    expect(await call("UpdateProfile", { hidden_from_sidebar: false })).toMatchObject({ target: "settings", hidden_from_sidebar: false });
    await expect(call("UpdateProfile", {})).rejects.toThrow("UpdateProfile requires at least one of name, description, title");

    await writeFile(join(store.botDirectory(botId), "picked.png"), PNG);
    expect(await call("UpdateAvatar", { action: "set", path: "picked.png" })).toMatchObject({ target: "avatar", updated: true, bytes: PNG.length });
    await expect(call("UpdateAvatar", { action: "set" })).rejects.toThrow("UpdateAvatar set requires path");
    expect(await call("UpdateAvatar", { action: "clear" })).toMatchObject({ target: "avatar", cleared: true });

    expect(await call("DisconnectChannel", { platform: "Slack" })).toMatchObject({ target: "channel", platform: "slack", disconnected: true });
    expect(await prisma.botConnectorState.findUniqueOrThrow({ where: { botId_platform: { botId, platform: "slack" } } })).toMatchObject({ connected: false });

    await expect(call("UpdateProject", { action: "create", project: "launch", name: "x" })).rejects.toThrow("Unknown tool UpdateProject");

    expect(await call("UpdateMemory", { action: "write", type: "journal", fact: "State tools fixture fact." })).toBe(
      "Remembered in your memory (journal): State tools fixture fact."
    );
    await expect(call("UpdateMemory", { action: "write", type: "project", fact: "x" })).rejects.toThrow("pick the memory type it belongs in");
    await expect(call("UpdateMemory", { action: "create", type: "profile", fact: "x" })).rejects.toThrow("UpdateMemory only writes or forgets memory");
    await expect(call("update_state", { target: "memory", action: "write", fact: "x" })).rejects.toThrow("Unknown tool update_state");
  } finally {
    if (botId) {
      await prisma.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
      await prisma.savedSkill.deleteMany({ where: { name: skillName } });
      await prisma.bot.deleteMany({ where: { id: botId } });
    }
    if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

databaseTest("a routine run reads and changes only its own routine, and may pause or delete others", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "routine-run-state-"));
  const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
  let botId = "";
  let channelId = "";
  try {
    const bot = await prisma.bot.create({
      data: { name: "Routine run", status: "active", onboardingStatus: "completed", defaultDirectory: root, conversation: { create: {} } },
      include: { conversation: true },
    });
    botId = bot.id;
    channelId = (await prisma.channel.create({
      data: { kind: "bot_dm", name: "main", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } },
    })).id;
    await store.initializeBot(botId);
    const routines = new RoutineService(prisma, { defaultTimeZone: "UTC", isTimelineSessionActive: async () => false } as never, store);
    const state = new DurableStateService(prisma, routines, store, { isTimelineSessionActive: async () => false } as never);
    const service = new InternalToolService(
      prisma, { agentData: store } as never, state, async () => {}, {} as never, {} as never, {} as never, {} as never
    );
    const create = (name: string) => routines.mutate(botId, crypto.randomUUID(), null, { action: "create", name, prompt: `${name} prompt`, schedule: "0 8 * * *" });
    const own = await create("Morning brief");
    const other = await create("Evening wrap");
    const third = await create("Weekly digest");
    const revision = await prisma.routineRevision.findFirstOrThrow({ where: { routineId: String(own.id) } });
    const run = await prisma.run.create({
      data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "running", origin: "routine" },
    });
    await prisma.routineExecution.create({
      data: { routineId: String(own.id), routineRevisionId: revision.id, runId: run.id, kind: "scheduled", status: "running", dedupeKey: crypto.randomUUID(), scheduledFor: new Date() },
    });
    const call = (args: unknown, runId = run.id) =>
      Effect.runPromise(service.execute({
        runId, botId, conversationId: bot.conversation!.id, channelId, deliveryId: null, tool: "UpdateRoutine", arguments: args, callId: crypto.randomUUID(),
      })) as Promise<any>;

    expect(await call({ action: "create", name: "Spawned", prompt: "x", schedule: "0 9 * * *" })).toEqual({
      target: "routine", action: "create",
      refused: "a routine run cannot create another routine. Tell the user what you wanted to schedule and let them ask for it in a conversation.",
    });
    expect((await call({ action: "update", id: String(other.folder), prompt: "rewritten" })).refused).toBe(
      "a routine run can only update the routine that started it. Tell the user what you wanted to change and let them ask for it in a conversation."
    );
    const enable = "a routine run cannot enable a routine. Tell the user what you wanted to resume and let them ask for it in a conversation.";
    expect((await call({ action: "update", id: String(own.folder), enabled: true })).refused).toBe(enable);
    expect((await call({ action: "resume", id: String(own.id) })).refused).toBe(enable);
    expect(await call({ action: "get", id: String(other.folder) })).toEqual({
      target: "routine", action: "get", refused: "a routine run can only read the routine that started it.",
    });
    // Its own routine can be read and edited; any routine can be paused or deleted.
    expect(await call({ action: "get", id: String(own.folder) })).toMatchObject({
      target: "routine", action: "get", name: "Morning brief", folder: own.folder, enabled: true,
      prompt: "Morning brief prompt", trigger: { type: "cron", schedule: "0 8 * * *" },
    });
    const edited = await call({ action: "update", id: String(own.id), prompt: "Shorter brief" });
    expect(edited).toMatchObject({ updated: true, prompt: "Shorter brief" });
    expect(edited).not.toHaveProperty("delivery_nudge");
    expect(await call({ action: "pause", id: String(other.folder) })).toMatchObject({ paused: true });
    expect(await call({ action: "delete", id: String(third.folder) })).toMatchObject({ deleted: true });
    expect(await prisma.routine.count({ where: { botId, deletedAt: null } })).toBe(2);

    // Outside a run, get reads any routine and an unknown folder names where the ids are.
    const turn = await prisma.run.create({
      data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "running" },
    });
    expect(await call({ action: "get", id: String(other.folder) }, turn.id)).toMatchObject({ name: "Evening wrap", enabled: false });
    await expect(call({ action: "get", id: "missing" }, turn.id)).rejects.toThrow(
      'no routine with folder "missing" exists. Your routines and their folder ids are listed under Scheduled routines in your prompt.'
    );
    expect(await call({ action: "create", name: "Allowed", prompt: "x", schedule: "0 9 * * *" }, turn.id)).toMatchObject({ created: true, delivery_nudge: true });
    expect(await call({ action: "pause", id: String(own.folder) }, turn.id)).not.toHaveProperty("delivery_nudge");
  } finally {
    if (botId) {
      await prisma.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
      await prisma.bot.deleteMany({ where: { id: botId } });
    }
    if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
