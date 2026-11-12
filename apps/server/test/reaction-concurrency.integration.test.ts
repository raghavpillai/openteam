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

test.skipIf(!url)("simultaneous different user reactions leave only the last serialized emoji for that actor", () => fixture(async f => {
  await Promise.all([f.react("👍"), f.react("❤️")]);
  const reactions = ((await f.stored()).metadata as { reactions: { by: string; emoji: string }[] }).reactions;
  const last = await f.db.event.findFirstOrThrow({ where: { topic: "channel.message.user_reaction", entityId: f.message.id }, orderBy: { sequence: "desc" } });
  expect(reactions).toEqual([{ by: "me", emoji: (last.payload as { emoji: string }).emoji }]);
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

test.skipIf(!url)("a bot cannot add a tapback after its target chat is archived", () => fixture(async f => {
  const context = await userContext(f);
  await f.db.channel.update({ where: { id: f.channel.id }, data: { archivedAt: new Date() } });
  const result = await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  expect(result).toMatchObject({ reacted: false, removed: false });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
}));

test.skipIf(!url)("feedback on a former group member's message does not wake that bot back into the group", () => fixture(async f => {
  const remaining = await f.db.bot.create({ data: { name: "Remaining member", status: "active", defaultDirectory: "/tmp", conversation: { create: {} } } });
  try {
    await f.db.channel.update({ where: { id: f.channel.id }, data: { kind: "group" } });
    await f.db.channelMember.create({ data: { channelId: f.channel.id, botId: remaining.id, ordinal: 1 } });
    await f.db.channelMember.delete({ where: { channelId_botId: { channelId: f.channel.id, botId: f.bot.id } } });
    const result = await f.react("👎");
    expect(result).toMatchObject({ reacted: true, removed: false, runId: null });
    expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "👎" }] });
    expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(0);
  } finally {
    await f.db.bot.delete({ where: { id: remaining.id } });
  }
}));

test.skipIf(!url)("a provider call id reused in a later run is a new bot tapback, not an old receipt", () => fixture(async f => {
  const context = { ...await userContext(f), callId: "call_0" };
  expect(await controlReact(f, context)).toMatchObject({ reacted: true });
  await f.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  const run = await f.db.run.create({ data: { botId: f.bot.id, channelId: f.channel.id, conversationId: f.bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running", origin: "user" } });
  expect(await controlReact(f, { ...context, runId: run.id })).toMatchObject({ reacted: false, removed: true });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
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

async function legacyTapback(f: Awaited<ReturnType<typeof setup>>, context: ToolContext, notification = true) {
  await f.db.run.update({ where: { id: context.runId }, data: { createdAt: new Date("2020-01-01") } });
  await f.db.channelMessage.update({ where: { id: f.message.id }, data: { metadata: { address: "t0u", reactions: [{ by: "agent", emoji: "👍" }] } } });
  const response = { reacted: true, removed: false, message_address: "t0u", emoji: "👍" };
  await f.db.idempotencyRecord.create({ data: {
    scope: `reaction:${f.bot.id}`, key: context.callId, requestHash: "t0u:👍", response, status: "completed",
    createdAt: new Date("2021-01-01"), expiresAt: new Date("2030-01-01"),
  } });
  if (notification) await f.db.channelNotification.create({ data: {
    key: `reaction:${f.message.id}:${f.bot.id}:👍:${context.callId}`,
    channelId: f.channel.id, botId: f.bot.id, kind: "reaction", messageSequence: f.message.sequence,
    payload: { schemaVersion: 1, kind: "reaction", botId: f.bot.id, channelId: f.channel.id,
      runId: context.runId, messageId: f.message.id, messageSequence: f.message.sequence.toString(), title: f.bot.name, body: "Reacted 👍" },
  } });
  return response;
}

test.skipIf(!url)("reused call ids produce a fresh notification after an add/remove/add across runs", () => fixture(async f => {
  await f.db.bot.update({ where: { id: f.bot.id }, data: { notificationsEnabled: true } });
  const context = { ...await userContext(f), callId: "call_0" };
  const outcomes = [];
  for (let i = 0; i < 3; i++) {
    const run = i === 0 ? { id: context.runId } : await f.db.run.create({ data: {
      botId: f.bot.id, channelId: f.channel.id, conversationId: f.bot.conversation!.id,
      userMessageId: crypto.randomUUID(), status: "running", origin: "user",
    } });
    outcomes.push(await controlReact(f, { ...context, runId: run.id }));
    await f.db.run.update({ where: { id: run.id }, data: { status: "completed" } });
  }
  expect(outcomes).toMatchObject([{ reacted: true }, { removed: true }, { reacted: true }]);
  const notifications = await f.db.channelNotification.findMany({ where: { channelId: f.channel.id }, orderBy: { sequence: "asc" } });
  expect(notifications).toHaveLength(2);
  expect(notifications.map(n => n.revoked)).toEqual([true, false]);
}));

test.skipIf(!url)("a legacy receipt older than the current run cannot suppress its new tapback", () => fixture(async f => {
  const context = { ...await userContext(f), callId: "call_0" };
  await legacyTapback(f, context, false);
  await f.db.run.update({ where: { id: context.runId }, data: { createdAt: new Date("2022-01-01") } });
  expect(await controlReact(f, context)).toMatchObject({ reacted: false, removed: true });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
}));

test.skipIf(!url)("an owned in-flight legacy tapback replays without undoing it and records its scoped receipt", () => fixture(async f => {
  const context = await userContext(f);
  const response = await legacyTapback(f, context);
  expect(await controlReact(f, context)).toEqual(response);
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
  expect(await f.db.idempotencyRecord.findUnique({ where: { scope_key: {
    scope: `reaction:${f.bot.id}:${context.runId}:${f.channel.id}`, key: context.callId,
  } } })).toMatchObject({ status: "completed", response });
  expect(await controlReact(f, context)).toEqual(response);
}));

test.skipIf(!url)("ambiguous in-flight legacy receipts fail honestly without undoing a reaction", () => fixture(async f => {
  const context = await userContext(f);
  await legacyTapback(f, context, false);
  await expect(controlReact(f, context)).rejects.toThrow("Cannot safely match an old reaction receipt");
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
  expect(await f.db.idempotencyRecord.count({ where: { scope: `reaction:${f.bot.id}:${context.runId}:${f.channel.id}` } })).toBe(0);
}));

test.skipIf(!url)("an owned legacy retry with changed arguments is rejected without another tapback", () => fixture(async f => {
  const context = await userContext(f);
  await legacyTapback(f, context);
  await expect(f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "❤️" })).rejects.toThrow("different arguments");
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
}));

test.skipIf(!url)("a legacy notification from a different run cannot authorize receipt replay", () => fixture(async f => {
  const context = await userContext(f);
  await legacyTapback(f, context);
  const key = `reaction:${f.message.id}:${f.bot.id}:👍:${context.callId}`;
  const notification = await f.db.channelNotification.findUniqueOrThrow({ where: { key } });
  await f.db.channelNotification.update({ where: { key }, data: {
    payload: { ...(notification.payload as Record<string, string>), runId: crypto.randomUUID() },
  } });
  await expect(controlReact(f, context)).rejects.toThrow("Cannot safely match an old reaction receipt");
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
}));

test.skipIf(!url)("a scoped bot reaction retry with changed arguments cannot toggle a second emoji", () => fixture(async f => {
  const context = await userContext(f);
  await controlReact(f, context);
  await expect(f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "❤️" })).rejects.toThrow("different arguments");
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "👍" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(1);
}));

test.skipIf(!url)("a different user emoji replaces the prior one and repeating it clears the user's reaction", () => fixture(async f => {
  await f.react("👍");
  expect(await f.react("❤️")).toMatchObject({ reacted: true, removed: false });
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "❤️" }] });
  expect(await f.react("❤️")).toMatchObject({ reacted: false, removed: true, runId: null });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(2);
}));

test.skipIf(!url)("a user emoji replacement preserves every other actor's reactions and unrelated metadata", () => fixture(async f => {
  const other = [{ by: "agent", emoji: "👍" }, { by: f.bot.id, emoji: "❤️" }];
  await f.db.channelMessage.update({ where: { id: f.message.id }, data: { metadata: { address: "t0s1", extra: "keep", reactions: [{ by: "me", emoji: "👍" }, ...other] } } });
  await f.react("❤️");
  expect((await f.stored()).metadata).toEqual({ address: "t0s1", extra: "keep", reactions: [...other, { by: "me", emoji: "❤️" }] });
}));

for (const emoji of ["❤️", "👍"]) test.skipIf(!url)(`legacy multiple user reactions normalize on the next ${emoji} tap without changing other actors`, () => fixture(async f => {
  const other = [{ by: "agent", emoji: "👍" }];
  await f.db.channelMessage.update({ where: { id: f.message.id }, data: { metadata: { reactions: [{ by: "me", emoji: "👍" }, { by: "me", emoji: "👎" }, ...other] } } });
  const result = await f.react(emoji);
  expect(result).toMatchObject(emoji === "👍" ? { reacted: false, removed: true, runId: null } : { reacted: true, removed: false });
  expect((await f.stored()).metadata).toEqual({ reactions: emoji === "👍" ? other : [...other, { by: "me", emoji }] });
}));

test.skipIf(!url)("replaying an older tap receipt returns the current message without restoring the old emoji or waking again", () => fixture(async f => {
  const oldKey = crypto.randomUUID(), latestKey = crypto.randomUUID();
  const old = await f.react("👍", oldKey);
  const latest = await f.react("❤️", latestKey);
  const replays = await Promise.all([f.react("👍", oldKey), f.react("❤️", latestKey), f.react("👍", oldKey)]);
  expect(replays[0]).toMatchObject({ runId: old.runId, reacted: true });
  expect(replays[1]).toMatchObject({ runId: latest.runId, reacted: true });
  for (const replay of replays) expect(replay.message.metadata).toMatchObject({ reactions: [{ by: "me", emoji: "❤️" }] });
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "❤️" }] });
  expect(await f.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(2);
  expect(await f.db.event.count({ where: { topic: "channel.message.user_reaction", entityId: f.message.id } })).toBe(2);
}));

test.skipIf(!url)("one bot replacement call leaves one emoji and revokes the replaced emoji's notification", () => fixture(async f => {
  const context = await userContext(f);
  await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  expect(await f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" })).toMatchObject({ reacted: true, removed: false });
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "❤️" }] });
  const notifications = await f.db.channelNotification.findMany({ where: { channelId: f.channel.id }, orderBy: { sequence: "asc" } });
  expect(notifications).toHaveLength(2);
  expect(notifications.map(n => n.revoked)).toEqual([true, false]);
  expect(notifications[1]!.payload).toMatchObject({ body: "Reacted ❤️ to “The result is 391.”" });
  expect(await f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" })).toMatchObject({ reacted: false, removed: true });
  expect((await f.stored()).metadata).not.toHaveProperty("reactions");
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id, revoked: false } })).toBe(0);
}));

test.skipIf(!url)("a bot's old call retry cannot restore the emoji replaced by its newer call", () => fixture(async f => {
  const context = await userContext(f);
  const first = await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  const replacement = { ...context, callId: crypto.randomUUID() };
  await f.messaging.reactToMessage(replacement, { message_address: "t0u", emoji: "❤️" });
  expect(await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" })).toEqual(first);
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "❤️" }] });
  expect(await f.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(2);
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id, revoked: false } })).toBe(1);
}));

test.skipIf(!url)("concurrent different bot emojis leave only the final serialized selection and its live notification", () => fixture(async f => {
  const context = await userContext(f);
  await Promise.all(["👍", "❤️"].map(emoji => f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji })));
  const last = await f.db.event.findFirstOrThrow({ where: { topic: "channel.message.reaction", entityId: f.message.id }, orderBy: { sequence: "desc" } });
  const emoji = (last.payload as { emoji: string }).emoji;
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji }] });
  const notifications = await f.db.channelNotification.findMany({ where: { channelId: f.channel.id, revoked: false } });
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.payload).toMatchObject({ body: `Reacted ${emoji} to “The result is 391.”` });
}));

for (const emoji of ["❤️", "👍"]) test.skipIf(!url)(`a group bot's ${emoji} tap normalizes its legacy reactions while preserving other reactors`, () => fixture(async f => {
  const context = await userContext(f);
  await f.db.channel.update({ where: { id: f.channel.id }, data: { kind: "group" } });
  const peer = await f.db.bot.create({ data: { name: "Peer reactor", status: "active", defaultDirectory: "/tmp", conversation: { create: {} } } });
  try {
    await f.db.channelMember.create({ data: { channelId: f.channel.id, botId: peer.id, ordinal: 1 } });
    const others = [{ by: "me", emoji: "👍" }, { by: peer.id, emoji: "👍" }];
    await f.db.channelMessage.update({ where: { id: f.message.id }, data: { metadata: { address: "t0u", reactions: [...others, { by: f.bot.id, emoji: "👍" }, { by: f.bot.id, emoji: "🎉" }] } } });
    const result = await f.messaging.reactToMessage(context, { message_address: "t0u", emoji });
    expect(result).toMatchObject(emoji === "👍" ? { removed: true, reacted: false } : { removed: false, reacted: true });
    expect((await f.stored()).metadata).toEqual({ address: "t0u", reactions: emoji === "👍" ? others : [...others, { by: f.bot.id, emoji }] });
  } finally { await f.db.bot.delete({ where: { id: peer.id } }); }
}));

test.skipIf(!url)("a bot emoji replacement does not leave the replaced emoji's alert deliverable", () => fixture(async f => {
  const context = await userContext(f);
  await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  await f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" });
  const notifications = await f.db.channelNotification.findMany({ where: { channelId: f.channel.id }, orderBy: { sequence: "asc" } });
  expect(notifications.map(n => n.revoked)).toEqual([true, false]);
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

test.skipIf(!url)("clearing a legacy bot selection revokes alerts for all its stored emojis", () => fixture(async f => {
  const context = await userContext(f);
  await f.db.channelMessage.update({ where: { id: f.message.id }, data: { metadata: { address: "t0u", reactions: [{ by: "agent", emoji: "👍" }, { by: "agent", emoji: "🎉" }, { by: "me", emoji: "❤️" }] } } });
  for (const emoji of ["👍", "🎉"]) await f.db.channelNotification.create({ data: {
    key: `reaction:${f.message.id}:${f.bot.id}:${emoji}:legacy`, channelId: f.channel.id, botId: f.bot.id, kind: "reaction",
    payload: { schemaVersion: 1, kind: "reaction", botId: f.bot.id, channelId: f.channel.id, runId: context.runId, messageId: f.message.id, title: f.bot.name, body: `Reacted ${emoji}` },
  } });
  expect(await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" })).toMatchObject({ reacted: false, removed: true });
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "me", emoji: "❤️" }] });
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id, revoked: false } })).toBe(0);
}));

test.skipIf(!url)("replacement retires an old bot alert even when notifications are disabled before the new emoji", () => fixture(async f => {
  const context = await userContext(f);
  await f.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  await f.db.bot.update({ where: { id: f.bot.id }, data: { notificationsEnabled: false } });
  await f.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" });
  expect((await f.stored()).metadata).toMatchObject({ reactions: [{ by: "agent", emoji: "❤️" }] });
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id } })).toBe(1);
  expect(await f.db.channelNotification.count({ where: { channelId: f.channel.id, revoked: false } })).toBe(0);
}));
