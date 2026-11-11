import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, type ToolContext } from "@openteam/messaging";
import { RunService } from "../src/services/run-service";
import { SubagentService } from "../src/services/subagent/service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    const children = await f.db.subagent.findMany({ where: { parentBotId: f.bot.id } });
    const ids = [f.bot.id, ...children.map(c => c.childBotId)];
    const channels = await f.db.channelMember.findMany({ where: { botId: { in: ids } } });
    await f.db.bot.deleteMany({ where: { id: { in: ids } } });
    await f.db.channel.deleteMany({ where: { id: { in: channels.map(c => c.channelId) } } });
    await f.db.$disconnect();
    await rm(f.dir, { recursive: true, force: true });
  }
}

async function setup() {
  const db = createPrismaClient(url!);
  const dir = await mkdtemp(join(tmpdir(), "legacy-request-stop-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  const messaging = new AgentMessaging(db, {
    send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID(),
  } as never, store);
  const bot = await db.bot.create({ data: { name: "Legacy stop owner", defaultDirectory: dir,
    status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
  const channel = await db.channel.create({ data: {
    kind: "bot_dm", name: "main", directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } },
  } });
  const parent = (status: "running" | "completed" = "completed") => db.run.create({ data: {
    botId: bot.id, conversationId: bot.conversation!.id, channelId: channel.id,
    userMessageId: crypto.randomUUID(), origin: "user", status,
  } });
  const completion = async (requestId: string) => {
    const wake = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: bot.id, channelId: channel.id, origin: "background_revival", type: "subagent.completed",
      content: "[SAND_HIDDEN_PROMPT]The legacy result is ready.", taskContextRunId: requestId,
      clientId: crypto.randomUUID(), priority: 260,
    }));
    return db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
  };
  const failures = new Set<string>();
  const computerFetch = async (path: string) => {
    if ([...failures].some(id => path.includes(id))) throw new Error("Synthetic cancellation transport failure");
    return Response.json({ stopped: true });
  };
  const service = new SubagentService(db, messaging, new RunService(db, computerFetch), dir, computerFetch, store);
  const send = (run: Awaited<ReturnType<typeof parent>> | Awaited<ReturnType<typeof completion>>) => messaging.sendVisible({
    botId: bot.id, runId: run.id, conversationId: bot.conversation!.id, channelId: channel.id,
    deliveryId: null, origin: run.origin, callId: crypto.randomUUID(),
  } as ToolContext, { type: "text", content: "The case was verified." });
  const legacyWorker = async (parentRunId: string, requestRunId: string | null) => {
    const child = await db.bot.create({ data: { name: "Legacy worker", defaultDirectory: dir,
      status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
    const childChannel = await db.channel.create({ data: { kind: "bot_dm", name: "Worker",
      directKey: `bot:${child.id}`, members: { create: { botId: child.id, ordinal: 0 } } } });
    const run = await db.run.create({ data: { botId: child.id, channelId: childChannel.id,
      conversationId: child.conversation!.id, userMessageId: crypto.randomUUID(), origin: "agent", status: "running" } });
    const sub = await db.subagent.create({ data: { parentBotId: bot.id, childBotId: child.id,
      parentRunId, requestRunId, parentChannelId: channel.id, currentRunId: run.id, launchCallId: crypto.randomUUID(),
      description: "Legacy inspection", prompt: "Read the existing case status only.", subagentType: "executor", status: "running", outputPath: "/tmp/legacy-result" } });
    await db.subagentAttempt.create({ data: { subagentId: sub.id, parentRunId, parentChannelId: channel.id,
      parentToolCallId: sub.launchCallId, childRunId: run.id, description: sub.description, prompt: sub.prompt, status: "running" } });
    return sub;
  };
  return { db, dir, bot, channel, service, messaging, parent, completion, failures, send, legacyWorker };
}

test.skipIf(!url)("actual Stop of a completed legacy root fences an already-running completion and preserves siblings", () => fixture(async f => {
  const root = await f.parent(), historical = await f.parent(), sibling = await f.parent("running");
  const wake = await f.completion(root.id);
  expect(root.requestProgress).toBeNull();
  expect(await Effect.runPromise(f.service.stopRun(root.id))).toMatchObject({ ok: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  expect((await f.db.run.findUniqueOrThrow({ where: { id: wake.id } })).status).toBe("running");
  await expect(f.send(wake)).rejects.toThrow("request was stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
  expect((await f.db.run.findUniqueOrThrow({ where: { id: sibling.id } })).requestStoppedAt).toBeNull();
  await f.send(sibling);
}));

test.skipIf(!url)("failed actual cancellation of an active legacy root still fences its running completion", () => fixture(async f => {
  const root = await f.parent("running"), historical = await f.parent();
  const wake = await f.completion(root.id);
  f.failures.add(root.id);
  await expect(Effect.runPromise(f.service.stopRun(root.id))).rejects.toThrow("Synthetic cancellation transport failure");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).status).toBe("running");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  await expect(f.send(wake)).rejects.toThrow("request was stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
}));

for (const scope of ["all", "bot"] as const)
test.skipIf(!url)(`${scope} Stop finds legacy roots through already-running completion contexts without marking unrelated history`, () => fixture(async f => {
  const root = await f.parent(), historical = await f.parent();
  const wake = await f.completion(root.id);
  if (scope === "bot") {
    f.failures.add(wake.id);
    await expect(Effect.runPromise(f.service.stopBot(f.bot.id))).rejects.toThrow("could not be stopped");
  } else await f.service.stop(f.bot.id, crypto.randomUUID(), { all: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  await expect(f.send(wake)).rejects.toThrow("request was stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
  await f.send(await f.parent("running"));
}));

for (const scope of ["all", "bot"] as const)
test.skipIf(!url)(`${scope} Stop records an active legacy user request without scanning all historical requests`, () => fixture(async f => {
  const root = await f.parent("running"), historical = await f.parent();
  if (scope === "bot") await Effect.runPromise(f.service.stopBot(f.bot.id));
  else await f.service.stop(f.bot.id, crypto.randomUUID(), { all: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
}));

for (const scope of ["all", "bot"] as const) for (const linked of [false, true])
test.skipIf(!url)(`${scope} Stop finds a completed legacy root through its worker's ${linked ? "requestRunId" : "parentRunId"}`, () => fixture(async f => {
  const root = await f.parent(), historical = await f.parent();
  const child = await f.legacyWorker(root.id, linked ? root.id : null);
  if (scope === "bot") await Effect.runPromise(f.service.stopBot(f.bot.id));
  else await f.service.stop(f.bot.id, crypto.randomUUID(), { all: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: child.currentRunId! } })).status).toBe("cancelled");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
}));

test.skipIf(!url)("all Stop follows a legacy worker's completed parent continuation to the original request", () => fixture(async f => {
  const root = await f.parent(), historical = await f.parent();
  const continuation = await f.completion(root.id);
  await f.db.run.update({ where: { id: continuation.id }, data: { status: "completed" } });
  const child = await f.legacyWorker(continuation.id, null);
  await f.service.stop(f.bot.id, crypto.randomUUID(), { all: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
}));

test.skipIf(!url)("stopping an already-cancelled legacy request reaches a worker attached through a later parent turn", () => fixture(async f => {
  const root = await f.parent(), sibling = await f.parent("running");
  const continuation = await f.completion(root.id);
  await f.db.run.update({ where: { id: continuation.id }, data: { status: "completed" } });
  const child = await f.legacyWorker(continuation.id, root.id);
  await f.db.run.update({ where: { id: root.id }, data: { status: "cancelled", completedAt: new Date(Date.now() - 60_000), error: { code: "cancelled_by_user" } } });
  await Effect.runPromise(f.service.stopRun(root.id));
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: sibling.id } })).requestStoppedAt).toBeNull();
  await f.send(sibling);
}));
