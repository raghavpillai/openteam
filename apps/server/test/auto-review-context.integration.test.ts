import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { loadAutoReviewContext } from "../src/services/auto-review-context";
import { RoutineService } from "@openteam/messaging";

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
      const routines = new RoutineService(db, { defaultTimeZone: "UTC", enqueueWake: async () => { throw new Error("not used"); } });
      const routine = await routines.mutate(parentId, crypto.randomUUID(), null, { action: "create", name: "Saved review authority", prompt: "Fill the synthetic form, do not upload files.", schedule: "@every 1h", enabled: false });
      const revision = await db.routineRevision.findFirstOrThrow({ where: { routineId: String(routine.id) } });
      await db.run.update({ where: { id: parentRun.id }, data: { origin: "routine" } });
      await db.routineExecution.create({ data: { routineId: String(routine.id), routineRevisionId: revision.id, runId: parentRun.id, dedupeKey: crypto.randomUUID(), scheduledFor: new Date(), kind: "scheduled", status: "running" } });
      const continuation = await db.run.create({ data: { botId: parentId, conversationId: parent.conversation!.id, channelId, origin: "routine", userMessageId: crypto.randomUUID(), status: "running" } });
      const continuationEvent = await db.inboxEvent.create({ data: { botId: parentId, conversationId: parent.conversation!.id, runId: continuation.id, idempotencyKey: crypto.randomUUID(), type: "subagent.completed", payload: { automationContextRunId: parentRun.id } } });
      const resumed = await loadAutoReviewContext(db, { runId: continuation.id, botId: parentId });
      expect(resumed.at(-1)).toEqual({ role: "user", source: "routine", content: revision.prompt });
      await db.subagent.update({ where: { childBotId: childId }, data: { parentRunId: continuation.id } });
      expect((await loadAutoReviewContext(db, { runId: childRun.id, botId: childId })).at(-1)?.content).toBe(revision.prompt);
      await db.inboxEvent.update({ where: { id: continuationEvent.id }, data: { payload: { automationContextRunId: childRun.id } } });
      await expect(loadAutoReviewContext(db, { runId: continuation.id, botId: parentId })).rejects.toThrow("automation context is unavailable");
      await db.subagent.update({ where: { childBotId: childId }, data: { parentRunId: parentRun.id } });
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
