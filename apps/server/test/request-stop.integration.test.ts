import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, ensureRequestForTask, stopRequestProgress, lockAgentLifecycle } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";

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
  const root = await db.run.create({ data: {
    botId: bot.id, conversationId: bot.conversation!.id, channelId: channel.id,
    userMessageId: crypto.randomUUID(), origin: "user", status: "completed",
  } });
  const wake = async () => {
    const queued = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: bot.id, channelId: channel.id, origin: "background_revival", type: "subagent.completed",
      content: "[SAND_HIDDEN_PROMPT]The requested result is ready.", taskContextRunId: root.id,
      clientId: crypto.randomUUID(), priority: 260,
    }));
    return db.run.update({ where: { id: queued.run.id }, data: { status: "running" } });
  };
  let connectedSends = 0;
  const tools = new InternalToolService(db, messaging, {} as never, async () => {}, {} as never,
    {} as never, {} as never, { deliverConnectedChannel: async () => {
      connectedSends++;
      return { connectionId: "fixture", toolName: "send" };
    } } as never);
  const send = (run: Awaited<ReturnType<typeof wake>>, channel?: string) => Effect.runPromise(tools.execute({
    runId: run.id, botId: bot.id, conversationId: bot.conversation!.id, channelId: run.channelId!,
    deliveryId: null, tool: "SendToUser", arguments: { type: "text", content: "The result is ready.", ...(channel ? { channel } : {}) },
    callId: crypto.randomUUID(),
  }));
  return { db, dir, bot, channel, messaging, root, wake, send, connectedSends: () => connectedSends };
}

for (const tracked of [true]) test.skipIf(!url)(`a running completion cannot deliver after Stop (${tracked ? "tracked" : "legacy"} request)`, () => fixture(async f => {
  if (tracked) await f.db.$transaction(tx => ensureRequestForTask(tx, f.bot.id, f.root.id));
  const run = await f.wake(); // Already claimed before Stop; cancellation transport fails to stop this turn.
  await f.db.run.update({ where: { id: f.root.id }, data: { requestStoppedAt: new Date() } });
  await expect(f.send(run)).rejects.toThrow("request was stopped");
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(0);
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id } })).toBe(0);
}));

for (const retiring of [false, true])
test.skipIf(!url)(`publication waits for a concurrent ${retiring ? "retirement and Stop" : "Stop"} transaction and reads its committed stop marker`, () => fixture(async f => {
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
    // Retirement acquires lifecycle before the request claim lock. Publication
    // must use that same order to avoid deadlocking with deletion.
    if (retiring) await lockAgentLifecycle(tx, f.bot.id);
    await stopRequestProgress(tx, f.bot.id, f.root.id);
    stopping(); await stopGate;
  });
  try {
    await stopWritten;
    releasePreparation();
    let waiting = false;
    const lockKey = `${retiring ? "agent-lifecycle" : "bot-run-claim"}:${f.bot.id}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await f.db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
        AND objid = hashtext(${lockKey})::oid AND NOT granted
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

test.skipIf(!url)("a running completion cannot send to a connected channel after Stop", () => fixture(async f => {
  const run = await f.wake();
  await f.db.run.update({ where: { id: f.root.id }, data: { requestStoppedAt: new Date() } });
  await expect(f.send(run, "slack:C123")).rejects.toThrow("request was stopped");
  expect(f.connectedSends()).toBe(0);
}));
