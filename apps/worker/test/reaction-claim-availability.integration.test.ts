import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging } from "@openteam/messaging";
import { ChannelService } from "../../server/src/services/channel-service";
import { WakeWorker } from "../src/worker";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    await f.db.idempotencyRecord.deleteMany({ where: { OR: [
      { scope: `channel-message:${f.message.id}:user-reaction` }, { scope: `channel:${f.group.id}:members` },
    ] } });
    await f.db.bot.deleteMany({ where: { id: { in: [f.bot.id, f.peer.id] } } });
    await f.db.channel.deleteMany({ where: { id: { in: [f.group.id, f.home.id] } } });
    await f.db.$disconnect();
  }
}

async function setup() {
  const db = createPrismaClient(url!);
  const makeBot = (name: string) => db.bot.create({ data: { name, status: "active", defaultDirectory: "/tmp", conversation: { create: {} } }, include: { conversation: true } });
  const bot = await makeBot("Queued feedback author"), peer = await makeBot("Remaining peer");
  const group = await db.channel.create({ data: { kind: "group", name: "Feedback group", members: { create: [{ botId: bot.id, ordinal: 0 }, { botId: peer.id, ordinal: 1 }] } } });
  const home = await db.channel.create({ data: { kind: "bot_dm", name: "Home", members: { create: { botId: bot.id, ordinal: 0 } } } });
  const message = await db.channelMessage.create({ data: { channelId: group.id, sender: "agent", senderBotId: bot.id, content: "The answer is 391." } });
  const messaging = new AgentMessaging(db, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never);
  const service = new ChannelService(db, messaging, "/tmp", async () => new Response(null, { status: 204 }));
  // Exercise the production claim transaction without starting queues, timers, or a computer.
  const worker = Object.assign(Object.create(WakeWorker.prototype), { prisma: db, messaging, workspaceRoot: "/tmp" }) as any;
  const react = (emoji: string) => Effect.runPromise(service.reactToMessage(message.id, { emoji, clientId: crypto.randomUUID() }));
  return { db, bot, peer, group, home, message, messaging, service, worker, react };
}

for (const emoji of ["👍", "👎"]) {
  test.skipIf(!url)(`queued ${emoji} feedback cannot claim after the author is removed from its group`, () => fixture(async f => {
    const result = await f.react(emoji);
    expect(result.runId).toBeString();
    await Effect.runPromise(f.service.setGroupMembers(f.group.id, { botIds: [f.peer.id], clientId: crypto.randomUUID() }));
    expect(await f.worker.claim(f.bot.id)).toBeNull();
    expect(await f.db.run.findUnique({ where: { id: result.runId! } })).toMatchObject({ status: "cancelled", error: { code: "reaction_channel_unavailable" } });
    expect(await f.db.inboxEvent.findFirst({ where: { runId: result.runId! } })).toMatchObject({ status: "completed" });
    expect(await f.db.botRunLease.count({ where: { botId: f.bot.id } })).toBe(0);
  }));

  test.skipIf(!url)(`queued ${emoji} feedback cannot claim after its chat is archived`, () => fixture(async f => {
    const result = await f.react(emoji);
    await f.db.channel.update({ where: { id: f.group.id }, data: { archivedAt: new Date() } });
    expect(await f.worker.claim(f.bot.id)).toBeNull();
    expect(await f.db.run.findUnique({ where: { id: result.runId! } })).toMatchObject({ status: "cancelled", error: { code: "reaction_channel_unavailable" } });
  }));

  test.skipIf(!url)(`ordinary ${emoji} feedback still claims in its live group and retains its reply guidance`, () => fixture(async f => {
    const result = await f.react(emoji);
    const claimed = await f.worker.claim(f.bot.id);
    expect(claimed).toMatchObject({ runId: result.runId, channelId: f.group.id, inboxType: "user.reaction", origin: "user" });
    expect(claimed.content).toContain(emoji === "👎" ? "Deliver your response with SendToUser" : "You don't need to reply");
  }));
}

test.skipIf(!url)("discarding unavailable group feedback does not block an independent home-chat user message", () => fixture(async f => {
  const result = await f.react("👎");
  await Effect.runPromise(f.service.setGroupMembers(f.group.id, { botIds: [f.peer.id], clientId: crypto.randomUUID() }));
  const direct = await f.db.$transaction(tx => f.messaging.enqueueWake(tx, { botId: f.bot.id, channelId: f.home.id, origin: "user", type: "user.message", content: "What is 2+2?", clientId: crypto.randomUUID(), priority: 300 }));
  expect(await f.worker.claim(f.bot.id)).toMatchObject({ runId: direct.run.id, channelId: f.home.id });
  expect(await f.db.run.findUnique({ where: { id: result.runId! } })).toMatchObject({ status: "cancelled" });
}));

test.skipIf(!url)("feedback claim waits for an in-flight group membership edit and checks its committed result", () => fixture(async f => {
  const result = await f.react("👎");
  let edited!: () => void, release!: () => void;
  const hasEdited = new Promise<void>(resolve => { edited = resolve; });
  const mayCommit = new Promise<void>(resolve => { release = resolve; });
  const edit = f.db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${f.group.id}`}))`;
    await tx.channelMember.delete({ where: { channelId_botId: { channelId: f.group.id, botId: f.bot.id } } });
    edited();
    await mayCommit;
  });
  await hasEdited;
  let settled = false;
  let waiting = false;
  const claim = f.worker.claim(f.bot.id).finally(() => { settled = true; });
  try {
    // Observe the database wait, rather than infer contention from a slow response.
    for (let attempt = 0; attempt < 50 && !waiting && !settled; attempt++) {
      const locks = await f.db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND objid = hashtext(${`channel:${f.group.id}`})::oid
      ) AS waiting`;
      waiting = locks[0]?.waiting ?? false;
      if (!waiting && !settled) await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  await edit;
  const claimed = await claim;
  expect(waiting).toBe(true);
  expect(claimed).toBeNull();
  expect(await f.db.run.findUnique({ where: { id: result.runId! } })).toMatchObject({ status: "cancelled" });
}));
