import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { postgresJson, postgresText } from "../src/postgres-json";
import { Projection } from "../src/projection";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!url);
let db: ReturnType<typeof createPrismaClient>;
let projection: Projection;
const bots: string[] = [];
const channels: string[] = [];
beforeAll(() => {
  if (!url) return;
  db = createPrismaClient(url);
  projection = new Projection(db);
});
afterAll(async () => {
  if (!url) return;
  await db.channel.deleteMany({ where: { id: { in: channels } } });
  await db.bot.deleteMany({ where: { id: { in: bots } } });
  await db.$disconnect();
});

/** An active bot with its DM channel and a running run, optionally from another channel. */
async function fixture(input: { status?: string; origin?: "group" } = {}) {
  const bot = await db.bot.create({ data: { name: "Projection fixture", defaultDirectory: "/tmp", status: "active", conversation: { create: {} } }, include: { conversation: true } });
  bots.push(bot.id);
  const dm = await db.channel.create({ data: { kind: "bot_dm", name: bot.name, directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } } } });
  channels.push(dm.id);
  let runChannel = dm.id;
  if (input.origin === "group") {
    runChannel = (await db.channel.create({ data: { kind: "group", name: "Projection room", members: { create: { botId: bot.id, ordinal: 0 } } } })).id;
    channels.push(runChannel);
  }
  const conversationId = bot.conversation!.id;
  const run = await db.run.create({ data: { botId: bot.id, conversationId, channelId: runChannel, userMessageId: crypto.randomUUID(), status: (input.status ?? "running") as never } });
  const apply = (event: Record<string, unknown>) => projection.apply(run.id, conversationId, bot.id, { turnId: run.id, ...event } as never);
  const reply = (channelId: string) => db.channelMessage.create({ data: { channelId, sender: "agent", senderBotId: bot.id, sourceRunId: run.id, content: "Finished output" } });
  const notifications = (channelId: string) => db.channelNotification.findMany({ where: { channelId } });
  return { bot, dm: dm.id, runChannel, conversationId, run, apply, reply, notifications };
}

test("projection text is PostgreSQL safe while retaining valid Unicode and literal escapes", () => {
  expect(postgresText("a\0b\ud800c\udc00 🌍 \\u0000")).toBe("a�b�c� 🌍 \\u0000");
  expect(postgresJson({ "k\0": ["v\0", null, 42] })).toEqual({ "k�": ["v�", null, 42] });
});

integration("started assistant text streams durably; replay and completion preserve it, and binary tool output is stored", async () => {
  const { run, conversationId, apply } = await fixture();
  const itemId = crypto.randomUUID();
  const start = () => apply({ type: "item.started", item: { id: itemId, type: "agentMessage", text: "", status: "inProgress" } });
  const delta = (text: string) => apply({ type: "agent.delta", itemId, delta: text });
  const row = () => db.message.findUniqueOrThrow({ where: { conversationId_upstreamItemId: { conversationId, upstreamItemId: itemId } } });
  await start();
  expect((await row()).status).toBe("streaming");
  await delta("Hello ");
  await start();
  await delta("世界 🙂");
  expect((await row()).content).toBe("Hello 世界 🙂");
  expect(await db.channelMessage.count({ where: { sourceRunId: run.id } })).toBe(0);
  await apply({ type: "item.completed", item: { id: itemId, type: "agentMessage", text: "Hello 世界 🙂", status: "completed" } });
  await start();
  await delta("LATE");
  expect(await row()).toMatchObject({ status: "completed", content: "Hello 世界 🙂" });
  // PostgreSQL rejects NUL in text and jsonb, so a binary tool result must be sanitized.
  await apply({ type: "item.completed", item: { id: "tool", type: "dynamicToolCall", tool: "Read", status: "completed", result: { content: [{ type: "text", text: "before\0after" }] } } });
  expect(JSON.stringify((await db.runItem.findFirstOrThrow({ where: { runId: run.id, upstreamItemId: "tool" } })))).toContain("before�after");
});

integration("reconciles exact archive epochs and projects stable compaction ids idempotently", async () => {
  const { bot, conversationId, apply } = await fixture();
  const context = await db.contextSession.create({ data: { botId: bot.id, scope: "home", scopeId: conversationId } });
  const archive = (id: string, sequence: number) => ({
    reason: "approaching_token_limit", prefixDigest: "a".repeat(64), summaryDigest: "b".repeat(64), tokensBefore: 95_000, tokensAfter: 2_000,
    imageCount: 0, turnCount: 42, startedAt: new Date(sequence).toISOString(), completedAt: new Date(sequence + 1).toISOString(), id, sequence,
  });
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
  await apply({ type: "context.state", contextSessionId: context.id, epoch: 1, archives: [archive(first, 1)] });
  expect(await db.contextSession.findUniqueOrThrow({ where: { id: context.id } })).toMatchObject({ compactionEpoch: 1 });
  expect((await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).compactionEpoch).toBe(1);
  const { id: _, sequence: __, ...rest } = archive(second, 2);
  const compaction = { type: "compaction", contextSessionId: context.id, compactionId: second, epoch: 2, ...rest, reason: "fallback_on_limit_error" };
  await apply(compaction);
  await apply(compaction);
  expect(await db.contextSession.findUniqueOrThrow({ where: { id: context.id } })).toMatchObject({ compactionEpoch: 2, lastArchiveId: second });
  expect((await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).compactionEpoch).toBe(2);
  expect(await db.contextCompaction.count({ where: { contextSessionId: context.id } })).toBe(2);
  expect(await db.event.count({ where: { topic: "conversation.compacted", entityId: conversationId } })).toBe(1);
});

integration("terminal runs notify through the bot's DM only when they produced a bot message there", async () => {
  // A cancelled run stays cancelled and still notifies for its new message.
  const cancelled = await fixture({ status: "cancelled" });
  await cancelled.reply(cancelled.dm);
  await cancelled.apply({ type: "turn.completed", status: "interrupted" });
  expect((await db.run.findUniqueOrThrow({ where: { id: cancelled.run.id } })).status).toBe("cancelled");
  expect(await cancelled.notifications(cancelled.dm)).toMatchObject([{ kind: "message", payload: { runId: cancelled.run.id } }]);
  // A group-origin run notifies only through the bot's private home message.
  const group = await fixture({ origin: "group" });
  await group.reply(group.runChannel);
  await group.reply(group.dm);
  await group.apply({ type: "turn.completed", status: "completed" });
  expect(await group.notifications(group.dm)).toHaveLength(1);
  expect(await group.notifications(group.runChannel)).toHaveLength(0);
  // Without a bot message nothing notifies.
  const silent = await fixture({ status: "cancelled" });
  await silent.apply({ type: "turn.completed", status: "interrupted" });
  expect(await silent.notifications(silent.dm)).toHaveLength(0);
});
