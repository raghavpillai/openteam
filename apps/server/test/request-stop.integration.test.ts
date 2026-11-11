import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, ensureRequestForTask, stopRequestProgress, type ToolContext } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
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
  const dir = await mkdtemp(join(tmpdir(), "request-stop-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  const messaging = new AgentMessaging(db, {
    send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID(),
  } as never, store);
  const bot = await db.bot.create({ data: { name: "Request stop owner", defaultDirectory: dir,
    status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
  const channel = await db.channel.create({ data: {
    kind: "bot_dm", name: "main", directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } },
  } });
  const parent = (status: "running" | "completed" = "completed") => db.run.create({ data: {
    botId: bot.id, conversationId: bot.conversation!.id, channelId: channel.id,
    userMessageId: crypto.randomUUID(), origin: "user", status,
  } });
  const completion = async (requestId: string, origin: "background_revival" | "user" = "background_revival") => {
    const wake = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: bot.id, channelId: channel.id, origin, type: origin === "user" ? "user.message" : "subagent.completed",
      content: origin === "user" ? "Stop. Please confirm." : "[SAND_HIDDEN_PROMPT]The requested result is ready.", taskContextRunId: requestId,
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
  const sendVisible = (run: Awaited<ReturnType<typeof parent>> | Awaited<ReturnType<typeof completion>>) => messaging.sendVisible({
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
  const root = await parent();
  const wake = (origin?: "background_revival" | "user") => completion(root.id, origin);
  let connectedSends = 0;
  const tools = new InternalToolService(db, messaging, {} as never, async () => {}, {} as never,
    {} as never, {} as never, { deliverConnectedChannel: async () => {
      connectedSends++;
      return { connectionId: "fixture", toolName: "send" };
    } } as never);
  const send = (run: Awaited<ReturnType<typeof wake>>, channel?: string, images?: { url: string }[]) => Effect.runPromise(tools.execute({
    runId: run.id, botId: bot.id, conversationId: bot.conversation!.id, channelId: run.channelId!,
    deliveryId: null, tool: "SendToUser", arguments: { type: "text", content: "The result is ready.", ...(channel ? { channel } : {}), ...(images ? { images } : {}) },
    callId: crypto.randomUUID(),
  }));
  return { db, dir, bot, channel, service, messaging, parent, completion, failures, sendVisible, legacyWorker, root, wake, send, connectedSends: () => connectedSends };
}

test.skipIf(!url)("actual Stop of a completed legacy root fences an already-running completion and preserves siblings", () => fixture(async f => {
  const root = await f.parent(), historical = await f.parent(), sibling = await f.parent("running");
  const wake = await f.completion(root.id);
  expect(root.requestProgress).toBeNull();
  expect(await Effect.runPromise(f.service.stopRun(root.id))).toMatchObject({ ok: true });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  expect((await f.db.run.findUniqueOrThrow({ where: { id: wake.id } })).status).toBe("running");
  await expect(f.sendVisible(wake)).rejects.toThrow("request was stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
  expect((await f.db.run.findUniqueOrThrow({ where: { id: sibling.id } })).requestStoppedAt).toBeNull();
  await f.sendVisible(sibling);
}));

test.skipIf(!url)("failed actual cancellation of an active legacy root still fences its running completion", () => fixture(async f => {
  const root = await f.parent("running"), historical = await f.parent();
  const wake = await f.completion(root.id);
  f.failures.add(root.id);
  await expect(Effect.runPromise(f.service.stopRun(root.id))).rejects.toThrow("Synthetic cancellation transport failure");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).status).toBe("running");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: root.id } })).requestStoppedAt).not.toBeNull();
  await expect(f.sendVisible(wake)).rejects.toThrow("request was stopped");
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
  await expect(f.sendVisible(wake)).rejects.toThrow("request was stopped");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: historical.id } })).requestStoppedAt).toBeNull();
  await f.sendVisible(await f.parent("running"));
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
  await f.sendVisible(sibling);
}));

for (const tracked of [false, true]) test.skipIf(!url)(`a running completion cannot deliver after Stop (${tracked ? "tracked" : "legacy"} request)`, () => fixture(async f => {
  if (tracked) await f.db.$transaction(tx => ensureRequestForTask(tx, f.bot.id, f.root.id));
  const run = await f.wake(); // Already claimed before Stop; cancellation transport fails to stop this turn.
  await f.db.run.update({ where: { id: f.root.id }, data: { requestStoppedAt: new Date() } });
  await expect(f.send(run)).rejects.toThrow("request was stopped");
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(0);
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id } })).toBe(0);
}));

test.skipIf(!url)("a Stop committed during attachment preparation prevents publication by an already executing SendToUser", () => fixture(async f => {
  await f.db.$transaction(tx => ensureRequestForTask(tx, f.bot.id, f.root.id));
  const run = await f.wake();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = (f.messaging as any).persistedVisibleInput.bind(f.messaging);
  (f.messaging as any).persistedVisibleInput = async (...args: unknown[]) => {
    entered();
    await gate;
    return original(...args);
  };
  const pending = f.send(run);
  try {
    await started;
    await f.db.$transaction(tx => stopRequestProgress(tx, f.bot.id, f.root.id));
    expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("running");
  } finally { release(); }
  await expect(pending).rejects.toThrow("request was stopped");
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(0);
}));

test.skipIf(!url)("an active completion can deliver; a priority interruption does not stop the request", () => fixture(async f => {
  await f.db.run.update({ where: { id: f.root.id }, data: { status: "cancelled", error: { code: "priority_peer_interrupt" } } });
  await f.send(await f.wake());
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(1);
}));

test.skipIf(!url)("publication waits for a concurrent Stop transaction and reads its committed stop marker", () => fixture(async f => {
  await f.db.$transaction(tx => ensureRequestForTask(tx, f.bot.id, f.root.id));
  const run = await f.wake();
  let preparing!: () => void, releasePreparation!: () => void;
  let stopping!: () => void, commitStop!: () => void;
  const prepared = new Promise<void>(resolve => { preparing = resolve; });
  const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
  const stopWritten = new Promise<void>(resolve => { stopping = resolve; });
  const stopGate = new Promise<void>(resolve => { commitStop = resolve; });
  const original = (f.messaging as any).persistedVisibleInput.bind(f.messaging);
  (f.messaging as any).persistedVisibleInput = async (...args: unknown[]) => {
    preparing(); await preparationGate; return original(...args);
  };
  const pending = f.send(run);
  await prepared;
  const stop = f.db.$transaction(async tx => {
    await stopRequestProgress(tx, f.bot.id, f.root.id);
    stopping(); await stopGate;
  });
  try {
    await stopWritten;
    releasePreparation();
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await f.db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
        AND objid = hashtext(${`bot-run-claim:${f.bot.id}`})::oid AND NOT granted
      ) AS waiting`;
      if (rows[0]?.waiting) { waiting = true; break; }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally { releasePreparation(); commitStop(); }
  await stop;
  await expect(pending).rejects.toThrow("request was stopped");
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(0);
}));

test.skipIf(!url)("a fresh user turn can acknowledge Stop even when referencing the stopped request", () => fixture(async f => {
  await f.db.run.update({ where: { id: f.root.id }, data: { requestStoppedAt: new Date() } });
  await f.send(await f.wake("user"));
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(1);
}));

test.skipIf(!url)("a running completion cannot send to a connected channel after Stop", () => fixture(async f => {
  const run = await f.wake();
  await f.db.run.update({ where: { id: f.root.id }, data: { requestStoppedAt: new Date() } });
  await expect(f.send(run, "slack:C123")).rejects.toThrow("request was stopped");
  expect(f.connectedSends()).toBe(0);
}));

test.skipIf(!url)("a Stop during connected-channel attachment preparation refuses before remote dispatch", () => fixture(async f => {
  await f.db.$transaction(tx => ensureRequestForTask(tx, f.bot.id, f.root.id));
  const run = await f.wake();
  const imagePath = join(f.dir, "fixture.png");
  await Bun.write(imagePath, new Uint8Array([137, 80, 78, 71]));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.messaging.assets.ingestSource = (async () => {
    entered(); await gate;
    return { assetId: "fixture", fileName: "fixture.png", mimeType: "image/png" };
  }) as never;
  f.messaging.assets.contentPath = () => imagePath;
  const pending = f.send(run, "slack:C123", [{ url: "https://fixture.invalid/image.png" }]);
  try {
    await started;
    await f.db.$transaction(tx => stopRequestProgress(tx, f.bot.id, f.root.id));
  } finally { release(); }
  await expect(pending).rejects.toThrow("request was stopped");
  expect(f.connectedSends()).toBe(0);
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "channel.delivery_failed" } })).toBe(0);
}));
