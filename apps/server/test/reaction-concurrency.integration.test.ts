import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging, type ToolContext } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    await f.db.idempotencyRecord.deleteMany({ where: { OR: [
      { scope: `channel-message:${f.message.id}:user-reaction` }, { scope: `reaction:${f.bot.id}` },
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

test.skipIf(!url)("simultaneous retries of one user reaction return one receipt and create one wake", () => fixture(async f => {
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.react("👎", key)));
  expect(results.every(r => r.runId === results[0]!.runId && r.reacted === true)).toBe(true);
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(1);
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "👎" }] });
}));

test.skipIf(!url)("simultaneous different user reactions do not overwrite each other", () => fixture(async f => {
  await Promise.all([f.react("👍"), f.react("❤️")]);
  const reactions = ((await f.stored()).metadata as { reactions: { emoji: string }[] }).reactions;
  expect(reactions.map(r => r.emoji).sort()).toEqual(["❤️", "👍"].sort());
}));

test.skipIf(!url)("a simultaneous reaction retry with changed arguments is rejected without a second toggle", () => fixture(async f => {
  const key = crypto.randomUUID();
  const results = await Promise.allSettled([f.react("👍", key), f.react("❤️", key)]);
  const accepted = results.filter(r => r.status === "fulfilled");
  const rejected = results.filter(r => r.status === "rejected");
  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0]!.reason)).toContain("Reaction idempotency key changed");
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(1);
}));

test.skipIf(!url)("two independent simultaneous taps of the same emoji toggle it back off", () => fixture(async f => {
  const results = await Promise.all([f.react("👍"), f.react("👍")]);
  expect(results.filter(r => r.reacted)).toHaveLength(1);
  expect(results.filter(r => r.removed)).toHaveLength(1);
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(1);
}));

test.skipIf(!url)("user and bot tapbacks on one user message preserve both actors", () => fixture(async f => {
  const context = await userContext(f);
  await Promise.all([f.react("❤️"), f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" })]);
  const reactions = ((await f.stored()).metadata as { reactions: { by: string; emoji: string }[] }).reactions;
  expect(reactions).toHaveLength(2);
  expect(reactions).toContainEqual({ by: "me", emoji: "❤️" });
  expect(reactions).toContainEqual({ by: "agent", emoji: "👍" });
}));

test.skipIf(!url)("simultaneous retries of one bot tapback do not toggle it off or duplicate its event", () => fixture(async f => {
  const context = await userContext(f);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" })));
  expect(results.every(r => r.reacted === true && r.removed === false)).toBe(true);
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(1);
}));

test.skipIf(!url)("distinct concurrent bot taps toggle off and revoke the first reaction notification", () => fixture(async f => {
  const context = await userContext(f);
  const results = await Promise.all([context, { ...context, callId: crypto.randomUUID() }]
    .map(c => f.messaging.reactToMessage(c, { message_address: "t0u", emoji: "👍" })));
  expect(results.filter(r => r.reacted)).toHaveLength(1);
  expect(results.filter(r => r.removed)).toHaveLength(1);
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id, revoked: false } })).toBe(0);
}));
