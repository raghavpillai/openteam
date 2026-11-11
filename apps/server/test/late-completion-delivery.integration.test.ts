import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, ensureRequestForTask, stopRequestProgress } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    await f.db.bot.delete({ where: { id: f.bot.id } });
    await f.db.channel.delete({ where: { id: f.channel.id } });
    await f.db.$disconnect();
    await rm(f.dir, { recursive: true, force: true });
  }
}

async function setup() {
  const db = createPrismaClient(url!);
  const dir = await mkdtemp(join(tmpdir(), "late-delivery-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  const messaging = new AgentMessaging(db, {
    send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID(),
  } as never, store);
  const bot = await db.bot.create({ data: {
    name: "Late delivery", status: "active", onboardingStatus: "completed", defaultDirectory: dir,
    conversation: { create: {} },
  }, include: { conversation: true } });
  const channel = await db.channel.create({ data: {
    kind: "bot_dm", name: "main", directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } },
  } });
  const root = await db.run.create({ data: {
    botId: bot.id, conversationId: bot.conversation!.id, channelId: channel.id,
    userMessageId: crypto.randomUUID(), status: "completed", origin: "user",
  } });
  const wake = async (origin: "background_revival" | "user" = "background_revival") => {
    const result = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: bot.id, channelId: channel.id, origin, type: origin === "user" ? "user.message" : "subagent.completed",
      content: origin === "user" ? "Stop. Please confirm." : "[SAND_HIDDEN_PROMPT]The requested result is ready.",
      clientId: crypto.randomUUID(), priority: 260, taskContextRunId: root.id,
    }));
    return db.run.update({ where: { id: result.run.id }, data: { status: "running" } });
  };
  let connectedSends = 0;
  const service = new InternalToolService(db, messaging, {} as never, async () => {}, {} as never,
    {} as never, {} as never, { deliverConnectedChannel: async () => {
      connectedSends++;
      return { connectionId: "fixture", toolName: "send" };
    } } as never);
  const send = (run: Awaited<ReturnType<typeof wake>>, channel?: string, images?: { url: string }[]) => Effect.runPromise(service.execute({
    runId: run.id, botId: bot.id, conversationId: bot.conversation!.id, channelId: run.channelId!,
    deliveryId: null, tool: "SendToUser", arguments: { type: "text", content: "The result is ready.", ...(channel ? { channel } : {}), ...(images ? { images } : {}) },
    callId: crypto.randomUUID(),
  }));
  return { db, dir, messaging, bot, channel, root, wake, send, connectedSends: () => connectedSends };
}

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
