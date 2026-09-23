import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@openteam/db";
import { RoutineService, reconcileRoutineExecution } from "@openteam/messaging";
import { DurableStateService } from "../src/update-state";
import { loadAutoReviewContext } from "../src/services/auto-review-context";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)(
  "room state mutations save the actual group owner, review uses current persisted task and immutable routine authority",
  async () => {
    const db = createPrismaClient(url!);
    const botId = randomUUID(),
      channelId = randomUUID();
    try {
      const bot = await db.bot.create({
        data: {
          id: botId,
          name: "Authority QA",
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
          name: "Authority room",
          members: { create: { botId, ordinal: 0 } },
        },
      });
      const prior = await db.channelMessage.create({
        data: {
          channelId,
          sender: "user",
          content: "For the old exchange, do not wait on other agents.",
        },
      });
      const current = await db.channelMessage.create({
        data: {
          channelId,
          sender: "user",
          content: "For this new task, open the synthetic form and fill it; never upload files.",
        },
      });
      const round = await db.channelRound.create({
        data: {
          channelId,
          rootMessageId: current.id,
          triggerMessageId: current.id,
          deliveries: { create: { botId, ordinal: 0 } },
        },
        include: { deliveries: true },
      });
      const run = await db.run.create({
        data: {
          botId,
          conversationId: bot.conversation!.id,
          channelId,
          origin: "group",
          status: "running",
          userMessageId: randomUUID(),
          deliveryId: round.deliveries[0]!.id,
        },
      });
      await db.channelMessage.create({
        data: { channelId, sender: "user", content: "Stop before submitting." },
      });
      const review = await loadAutoReviewContext(db, { runId: run.id, botId });
      expect(review.map((row) => row.taskPhase)).toEqual(["prior", "current", "followup"]);
      expect(review[0]!.content).toBe(prior.content);
      expect(review[2]!.content).toBe("Stop before submitting.");
      const host = {
        defaultTimeZone: "UTC",
        enqueueWake: async () => {
          throw new Error("not used");
        },
      };
      const routines = new RoutineService(db, host);
      const state = new DurableStateService(
        db,
        "/tmp",
        async () => {},
        routines,
        { reconcileBot: async () => {}, projectBot: async () => {} } as never,
        host
      );
      const input = {
        target: "routine" as const,
        action: "create" as const,
        name: "Group authority routine",
        prompt: "Read only the synthetic page. Do not upload files.",
        schedule: "@every 5m",
        enabled: false,
      };
      const saved = await state.execute(botId, randomUUID(), input, run.id);
      expect(saved.owner).toEqual({ kind: "group", id: channelId, name: "Authority room" });
      const routine = await db.routine.findUniqueOrThrow({
        where: { id: String(saved.id) },
        include: { revisions: true },
      });
      expect(routine.botId).toBeNull();
      expect(routine.channelId).toBe(channelId);
      await db.routineExecution.create({
        data: {
          routineId: routine.id,
          routineRevisionId: routine.revisions[0]!.id,
          channelMessageId: current.id,
          dedupeKey: randomUUID(),
          scheduledFor: new Date(),
          kind: "scheduled",
        },
      });
      const withRoutine = await loadAutoReviewContext(db, { runId: run.id, botId });
      expect(withRoutine.at(-1)).toEqual({
        role: "user",
        source: "routine",
        content: input.prompt,
      });
      const continuation = await db.run.create({
        data: {
          botId,
          conversationId: bot.conversation!.id,
          channelId,
          origin: "background_revival",
          status: "running",
          userMessageId: randomUUID(),
        },
      });
      await db.inboxEvent.create({
        data: {
          botId,
          conversationId: bot.conversation!.id,
          runId: continuation.id,
          idempotencyKey: randomUUID(),
          type: "subagent.completed",
          payload: { taskContextRunId: run.id },
        },
      });
      const resumed = await loadAutoReviewContext(db, { runId: continuation.id, botId });
      expect(resumed.map((row) => row.taskPhase)).toEqual([
        "prior",
        "current",
        "followup",
        undefined,
      ]);
      expect(resumed.at(-1)?.content).toBe(input.prompt);
      await db.channelMember.deleteMany({ where: { channelId } });
      await expect(loadAutoReviewContext(db, { runId: run.id, botId })).rejects.toThrow(
        "unavailable"
      );
    } finally {
      await db.idempotencyRecord.deleteMany({ where: { scope: `update_state:${botId}` } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);

test.skipIf(!url)(
  "failed WakeParent marks routine failed; successful retried handoff can complete",
  async () => {
    const db = createPrismaClient(url!);
    const botId = randomUUID(),
      channelId = randomUUID();
    try {
      const bot = await db.bot.create({
        data: {
          id: botId,
          name: "Handoff QA",
          defaultDirectory: "/tmp",
          status: "active",
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      await db.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name: "Handoff QA",
          members: { create: { botId, ordinal: 0 } },
        },
      });
      const service = new RoutineService(db, {
        defaultTimeZone: "UTC",
        enqueueWake: async () => {
          throw new Error("not used");
        },
      });
      const routine = await service.mutate(botId, randomUUID(), null, {
        action: "create" as const,
        name: "Handoff fixture",
        prompt: "Return a report via parent.",
        schedule: "@every 5m",
        enabled: false,
      });
      const revision = await db.routineRevision.findFirstOrThrow({
        where: { routineId: String(routine.id) },
      });
      for (const retried of [false, true]) {
        const run = await db.run.create({
          data: {
            botId,
            conversationId: bot.conversation!.id,
            channelId,
            origin: "routine",
            status: "completed",
            userMessageId: randomUUID(),
            completedAt: new Date(),
          },
        });
        const execution = await db.routineExecution.create({
          data: {
            routineId: revision.routineId,
            routineRevisionId: revision.id,
            runId: run.id,
            status: "running",
            kind: "test",
            scheduledFor: new Date(),
            dedupeKey: randomUUID(),
          },
        });
        await db.runItem.create({
          data: {
            runId: run.id,
            kind: "tool",
            status: "failed",
            title: "WakeParent",
            content: { error: "Pending approval" },
          },
        });
        if (retried) {
          const wake = await db.run.create({
            data: {
              botId,
              conversationId: bot.conversation!.id,
              channelId,
              origin: "background_revival",
              status: "completed",
              userMessageId: randomUUID(),
            },
          });
          await db.automationResult.create({
            data: { runId: run.id, wakeRunId: wake.id, message: "Report handed off" },
          });
        }
        await db.$transaction((tx) => reconcileRoutineExecution(tx, run.id));
        const result = await db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } });
        expect(result.status).toBe(retried ? "completed" : "failed");
        if (!retried) expect((result.error as any).code).toBe("automation_handoff_failed");
      }
    } finally {
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);
