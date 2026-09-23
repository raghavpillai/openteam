import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Projection } from "../src/projection";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)("started assistant text streams durably; replay and completion preserve it", async () => {
  const db = createPrismaClient(url!);
  const bot = await db.bot.create({ data: { name: "Streaming fixture", defaultDirectory: "/tmp", status: "active" } });
  try {
    const conversation = await db.conversation.create({ data: { botId: bot.id } });
    const run = await db.run.create({ data: { botId: bot.id, conversationId: conversation.id, userMessageId: crypto.randomUUID(), status: "running" } });
    const projection = new Projection(db);
    const itemId = crypto.randomUUID();
    const start = () => projection.apply(run.id, conversation.id, bot.id, { type: "item.started", turnId: run.id, item: { id: itemId, type: "agentMessage", text: "", status: "inProgress" } });
    const delta = (text: string) => projection.apply(run.id, conversation.id, bot.id, { type: "agent.delta", turnId: run.id, itemId, delta: text });
    const row = () => db.message.findUniqueOrThrow({ where: { conversationId_upstreamItemId: { conversationId: conversation.id, upstreamItemId: itemId } } });
    await start();
    expect((await row()).status).toBe("streaming");
    await delta("Hello ");
    await start();
    await delta("世界 🙂");
    expect((await row()).content).toBe("Hello 世界 🙂");
    expect(await db.channelMessage.count({ where: { sourceRunId: run.id } })).toBe(0);
    await projection.apply(run.id, conversation.id, bot.id, { type: "item.completed", turnId: run.id, item: { id: itemId, type: "agentMessage", text: "Hello 世界 🙂", status: "completed" } });
    await start();
    await delta("LATE");
    expect(await row()).toMatchObject({ status: "completed", content: "Hello 世界 🙂" });
  } finally {
    await db.bot.delete({ where: { id: bot.id } });
    await db.$disconnect();
  }
});
