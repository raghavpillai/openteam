// User and bot tapbacks on chat messages: wakes, receipts, idempotency and group pills.
import { expect } from "bun:test";
import { Effect } from "effect";
import type { ToolContext } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";
import { InternalToolService } from "../src/services/internal-tool-service";
import { dbIt, type Harness } from "./harness";

async function setup(h: Harness) {
  const bot = await h.bot("Reaction probe");
  const message = await h.db.channelMessage.create({ data: { channelId: bot.channelId!, sender: "agent", senderBotId: bot.id, content: "The deployment finished." } });
  const service = new ChannelService(h.db, h.messaging, h.dir, async () => new Response(null, { status: 204 }), h.store, h.messaging.assets);
  const react = (emoji: string, clientId: string = crypto.randomUUID()) => Effect.runPromise(service.reactToMessage(message.id, { emoji, clientId, timeZone: "Asia/Jerusalem" }));
  const stored = async () => (await h.db.channelMessage.findUniqueOrThrow({ where: { id: message.id } })).metadata;
  /** Turns the message into a user message the bot can react to from a running turn. */
  const userTurn = async (): Promise<ToolContext> => {
    await h.db.channelMessage.update({ where: { id: message.id }, data: { sender: "user", senderBotId: null, metadata: { address: "t0u" } } });
    return h.context(bot, { runId: (await h.run(bot)).id });
  };
  return { bot, message, react, stored, userTurn };
}

for (const emoji of ["👍", "👎"]) dbIt(`a ${emoji} reaction wakes the authoring Bot as priority user input`, async h => {
  const f = await setup(h);
  const added = await f.react(emoji) as any;
  expect(added).toMatchObject({ reacted: true, removed: false, message: { id: f.message.id, metadata: { reactions: [{ by: "me", emoji }] } } });
  const run = await h.db.run.findUniqueOrThrow({ where: { id: String(added.runId) }, include: { messages: true, inboxEvents: true } });
  expect(run.origin).toBe("user");
  expect(run.messages[0]?.content).toContain("The user reacted " + emoji);
  if (emoji === "👎") {
    expect(run.messages[0]?.content).toContain("Deliver your response with SendToUser");
    expect(run.messages[0]?.content).not.toContain("You don't need to reply");
  } else expect(run.messages[0]?.content).toContain("You don't need to reply");
  expect(run.inboxEvents[0]).toMatchObject({ type: "user.reaction", priority: 300, payload: { origin: "user" } });
  // The event log carries the change, not a second copy of the message.
  const event = await h.db.event.findFirstOrThrow({ where: { topic: "channel.message.user_reaction", entityId: f.message.id } });
  expect(event.payload).not.toHaveProperty("message");

  expect(await f.react(emoji)).toMatchObject({ reacted: false, removed: true, runId: null });
  expect(await h.db.run.count({ where: { botId: f.bot.id, origin: "user" } })).toBe(1);
  expect(h.jobs.filter(({ name }) => name === "bot-wake")).toHaveLength(1);
  expect(h.jobs.some(({ name }) => name === "transcript-project")).toBe(true);
});

dbIt("simultaneous retries of one user reaction return one receipt and create one wake", async h => {
  const f = await setup(h);
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.react("👎", key)));
  expect(results.every(r => r.runId === results[0]!.runId && r.reacted === true)).toBe(true);
  expect(await h.db.inboxEvent.count({ where: { botId: f.bot.id, type: "user.reaction" } })).toBe(1);
  expect(await f.stored()).toMatchObject({ reactions: [{ by: "me", emoji: "👎" }] });
});

dbIt("a bot cannot add a tapback after its target chat is archived", async h => {
  const f = await setup(h);
  const context = await f.userTurn();
  await h.db.channel.update({ where: { id: f.bot.channelId! }, data: { archivedAt: new Date() } });
  expect(await h.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" })).toMatchObject({ reacted: false, removed: false });
  expect(await f.stored()).not.toHaveProperty("reactions");
  expect(await h.db.event.count({ where: { topic: "channel.message.reaction", entityId: f.message.id } })).toBe(0);
});

dbIt("a reused provider call id cannot replay another channel's bot tapback receipt", async h => {
  const f = await setup(h);
  const tools = new InternalToolService(h.db, h.messaging, {} as never, async () => {}, {} as never, {} as never, {} as never, {} as never);
  const react = (context: ToolContext) => Effect.runPromise(tools.execute({ ...context, tool: "ReactToMessage", arguments: { message_address: "t0u", emoji: "👍" } } as never));
  const context = { ...await f.userTurn(), callId: "call_0" };
  await react(context);
  await h.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  const group = await h.channel({ kind: "group", name: "Second chat", members: { create: { botId: f.bot.id, ordinal: 0 } } });
  const message = await h.db.channelMessage.create({ data: { channelId: group.id, sender: "user", content: "Thanks", metadata: { address: "t0u" } } });
  const run = await h.run(f.bot, { channelId: group.id });
  expect(await react({ ...context, channelId: group.id, runId: run.id })).toMatchObject({ reacted: true });
  expect((await h.db.channelMessage.findUniqueOrThrow({ where: { id: message.id } })).metadata).toMatchObject({ reactions: [{ by: f.bot.id, emoji: "👍" }] });
});

dbIt("one group bot replacing its emoji preserves the peer bot's pill and live notification", async h => {
  const f = await setup(h);
  const context = await f.userTurn();
  await h.db.channel.update({ where: { id: f.bot.channelId! }, data: { kind: "group" } });
  const peer = await h.bot("Peer reactor", {}, { dm: false });
  await h.db.channelMember.create({ data: { channelId: f.bot.channelId!, botId: peer.id, ordinal: 1 } });
  const run = await h.run(peer, { channelId: f.bot.channelId });
  await h.messaging.reactToMessage(context, { message_address: "t0u", emoji: "👍" });
  await h.messaging.reactToMessage({ ...context, botId: peer.id, conversationId: peer.conversationId, runId: run.id, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "🎉" });
  await h.messaging.reactToMessage({ ...context, callId: crypto.randomUUID() }, { message_address: "t0u", emoji: "❤️" });
  expect(await f.stored()).toMatchObject({ reactions: [{ by: peer.id, emoji: "🎉" }, { by: f.bot.id, emoji: "❤️" }] });
  const notifications = await h.db.channelNotification.findMany({ where: { channelId: f.bot.channelId! }, orderBy: { sequence: "asc" } });
  expect(notifications.map(n => ({ botId: n.botId, revoked: n.revoked }))).toEqual([
    { botId: f.bot.id, revoked: true }, { botId: peer.id, revoked: false }, { botId: f.bot.id, revoked: false },
  ]);
});
