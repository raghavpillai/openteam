import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging, type ToolContext } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";
import { InternalToolService } from "../src/services/internal-tool-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    await f.db.idempotencyRecord.deleteMany({ where: { OR: [
      { scope: `channel-message:${f.message.id}:user-reaction` }, { scope: `reaction:${f.bot.id}` },
      { scope: { startsWith: `reaction:${f.bot.id}:` } },
    ] } });
    await f.db.bot.delete({ where: { id: f.bot.id } });
    await f.db.channel.delete({ where: { id: f.channel.id } });
    await f.db.$disconnect();
  }
}

async function setup() {
  const db = createPrismaClient(url!);
  const bot = await db.bot.create({ data: { name: "Reaction race", status: "active", defaultDirectory: "/tmp", conversation: { create: {} } }, include: { conversation: true } });
  const channel = await db.channel.create({ data: { kind: "bot_dm", name: "Reaction race", members: { create: { botId: bot.id, ordinal: 0 } } } });
  const message = await db.channelMessage.create({ data: { channelId: channel.id, sender: "agent", senderBotId: bot.id, content: "The result is 391." } });
  const messaging = new AgentMessaging(db, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never);
  const service = new ChannelService(db, messaging, "/tmp", async () => Response.json({}));
  const react = (emoji: string, clientId = crypto.randomUUID()) => Effect.runPromise(service.reactToMessage(message.id, { emoji, clientId }));
  const stored = () => db.channelMessage.findUniqueOrThrow({ where: { id: message.id } });
  return { db, bot, channel, message, messaging, react, stored };
}

async function userContext(f: Awaited<ReturnType<typeof setup>>): Promise<ToolContext> {
  await f.db.channelMessage.update({ where: { id: f.message.id }, data: { sender: "user", senderBotId: null, metadata: { address: "t0u" } } });
  const run = await f.db.run.create({ data: { botId: f.bot.id, channelId: f.channel.id, conversationId: f.bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running", origin: "user" } });
  return { botId: f.bot.id, channelId: f.channel.id, conversationId: f.bot.conversation!.id, runId: run.id, deliveryId: null, origin: "user", callId: crypto.randomUUID(), isFork: false, replyToMessageId: null };
}

function controlReact(f: Awaited<ReturnType<typeof setup>>, context: ToolContext) {
  const tools = new InternalToolService(f.db, f.messaging, {} as never, async () => {}, {} as never, {} as never, {} as never, {} as never);
  return Effect.runPromise(tools.execute({
    runId: context.runId, botId: context.botId, conversationId: context.conversationId!, channelId: context.channelId!,
    deliveryId: context.deliveryId, callId: context.callId, tool: "ReactToMessage",
    arguments: { message_address: "t0u", emoji: "👍" },
  }));
}

test.skipIf(!url)("simultaneous retries of one user reaction return one receipt and create one wake", () => fixture(async f => {
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.react("👎", key)));
  expect(results.every(r => r.runId === results[0]!.runId && r.reacted === true)).toBe(true);
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(1);
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "👎" }] });
}));

test.skipIf(!url)("a bot cannot add a tapback after its target chat is archived", () => fixture(async f => {
  const context = await userContext(f);
  await f.db.channel.update({ where: { id: f.channel.id }, data: { archivedAt: new Date() } });
  const result = await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  expect(result).toMatchObject({ reacted: false, removed: false });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
}));

test.skipIf(!url)("a reused provider call id cannot replay another channel's bot tapback receipt", () => fixture(async f => {
  const context = { ...await userContext(f), callId: "call_0" };
  await controlReact(f, context);
  await f.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  const group = await f.db.channel.create({ data: { kind: "group", name: "Second chat", members: { create: { botId: f.bot.id, ordinal: 0 } } } });
  try {
    const message = await f.db.channelMessage.create({ data: { channelId: group.id, sender: "user", content: "Thanks", metadata: { address: "t0u" } } });
    const run = await f.db.run.create({ data: { botId: f.bot.id, channelId: group.id, conversationId: f.bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running", origin: "user" } });
    expect(await controlReact(f, { ...context, channelId: group.id, runId: run.id })).toMatchObject({ reacted: true });
    expect((await f.db.channelMessage.findUniqueOrThrow({ where: { id: message.id } })).metadata).toMatchObject({ reactions: [{ by: f.bot.id, emoji: "👍" }] });
  } finally {
    await f.db.channel.delete({ where: { id: group.id } });
  }
}));

test.skipIf(!url)("one group bot replacing its emoji preserves the peer bot's pill and live notification", () => fixture(async f => {
  const context = await userContext(f);
  await f.db.channel.update({ where: { id: f.channel.id }, data: { kind: "group" } });
  const peer = await f.db.bot.create({ data: { name: "Peer reactor", status: "active", defaultDirectory: "/tmp", conversation: { create: {} } }, include: { conversation: true } });
  try {
    await f.db.channelMember.create({ data: { channelId: f.channel.id, botId: peer.id, ordinal: 1 } });
    const run = await f.db.run.create({ data: { botId: peer.id, conversationId: peer.conversation!.id, channelId: f.channel.id, userMessageId: crypto.randomUUID(), status: "running", origin: "user" } });
    const peerContext = { ...context, botId: peer.id, conversationId: peer.conversation!.id, runId: run.id, callId: crypto.randomUUID() };
    await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
    await f.messaging.reactToMessage(peerContext, { message_address: "t0u", emoji: "🎉" });
    await f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" });
    expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: peer.id, emoji: "🎉" }, { by: f.bot.id, emoji: "❤️" }] });
    const notifications = await f.db.channelNotification.findMany({ where: { channelId: f.channel.id }, orderBy: { sequence: "asc" } });
    expect(notifications.map(n => ({ botId: n.botId, revoked: n.revoked }))).toEqual([
      { botId: f.bot.id, revoked: true }, { botId: peer.id, revoked: false }, { botId: f.bot.id, revoked: false },
    ]);
  } finally {
    await f.db.idempotencyRecord.deleteMany({ where: { scope: { startsWith: `reaction:${peer.id}:` } } });
    await f.db.bot.delete({ where: { id: peer.id } });
  }
}));
