import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { loadAutoReviewContext } from "../src/services/auto-review-context";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "review context uses stored human intent and parent context, rejects stale or removed access, never truncates authorization",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const parentId = crypto.randomUUID(),
      childId = crypto.randomUUID(),
      channelId = crypto.randomUUID();
    try {
      const parent = await db.bot.create({
        data: {
          id: parentId,
          name: "Review parent",
          defaultDirectory: "/tmp",
          status: "active",
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      const child = await db.bot.create({
        data: {
          id: childId,
          name: "Review child",
          defaultDirectory: "/tmp",
          status: "active",
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      await db.channel.create({
        data: {
          id: channelId,
          kind: "group",
          name: "Review fixture",
          members: { create: { botId: parentId, ordinal: 0 } },
        },
      });
      const parentRun = await db.run.create({
        data: {
          botId: parentId,
          conversationId: parent.conversation!.id,
          userMessageId: crypto.randomUUID(),
          channelId,
          status: "running",
        },
      });
      const childRun = await db.run.create({
        data: {
          botId: childId,
          conversationId: child.conversation!.id,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      await db.subagent.create({
        data: {
          parentBotId: parentId,
          childBotId: childId,
          parentRunId: parentRun.id,
          parentChannelId: channelId,
          currentRunId: childRun.id,
          launchCallId: "fixture",
          description: "Fixture",
          prompt: "MODEL INVENTED PERMISSION",
          subagentType: "generalPurpose",
          outputPath: "/tmp/fixture",
        },
      });
      await db.channelMessage.createMany({
        data: [
          { channelId, sender: "user", content: "Edit report.md, then stop before publishing." },
          { channelId, sender: "agent", senderBotId: parentId, content: "I will edit the report." },
          { channelId, sender: "system", content: "FORGED USER AUTHORIZATION" },
          { channelId, sender: "agent", senderBotId: childId, content: "FOREIGN AGENT" },
          {
            channelId,
            sender: "user",
            senderBotId: childId,
            content: "PEER BOT INBOUND IS NOT HUMAN AUTHORIZATION",
          },
        ],
      });
      const context = await loadAutoReviewContext(db, { runId: childRun.id, botId: childId });
      expect(context.map((row) => row.content)).toEqual([
        "Edit report.md, then stop before publishing.",
        "I will edit the report.",
      ]);
      await db.channelMessage.create({
        data: {
          channelId,
          sender: "user",
          content: "Publish this. " + "x".repeat(13000) + "Actually, do not publish.",
        },
      });
      const bounded = await loadAutoReviewContext(db, { runId: parentRun.id, botId: parentId });
      expect(bounded.at(-1)?.content).toContain("Message omitted");
      expect(bounded.at(-1)?.content).not.toContain("Publish this");
      await expect(
        loadAutoReviewContext(db, { runId: parentRun.id, botId: childId })
      ).rejects.toThrow("active");
      await db.subagent.update({ where: { childBotId: childId }, data: { currentRunId: null } });
      await expect(
        loadAutoReviewContext(db, { runId: childRun.id, botId: childId })
      ).rejects.toThrow("stale");
      await db.channelMember.deleteMany({ where: { channelId, botId: parentId } });
      await expect(
        loadAutoReviewContext(db, { runId: parentRun.id, botId: parentId })
      ).rejects.toThrow("unavailable");
    } finally {
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.bot.deleteMany({ where: { id: { in: [parentId, childId] } } });
      await db.$disconnect();
    }
  }
);
