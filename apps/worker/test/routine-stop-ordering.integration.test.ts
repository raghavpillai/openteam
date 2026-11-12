import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createRoutineHarness } from "./fixtures/routine-context";
import { wakeAutomationParent } from "../../../packages/messaging/src/automation-results";
import { SubagentService } from "../../server/src/services/subagent/service";
import { RunService } from "../../server/src/services/run-service";
import type { ToolContext } from "@openteam/messaging";

let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (process.env.OPENTEAM_TEST_DATABASE_URL) harness = await createRoutineHarness();
});
afterAll(async () => {
  await harness?.close();
});
const integration = test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL);
type Fixture = Awaited<ReturnType<typeof harness.fixture>>;
const context = (
  f: Fixture,
  runId: string,
  origin: ToolContext["origin"] = "routine"
): ToolContext => ({
  botId: f.botId,
  conversationId: f.conversationId,
  channelId: f.channelId,
  runId,
  callId: randomUUID(),
  origin,
  isFork: false,
  deliveryId: null,
  replyToMessageId: null,
});
const callback = (f: Fixture, runId: string) =>
  f.messaging.completeShell({
    id: randomUUID(),
    scope: f.botId,
    channelId: f.channelId,
    automationRunId: runId,
    outputPath: `/tmp/stop-ordering-${randomUUID()}.log`,
    exitCode: 0,
    title: "Finished",
  });
function stops(f: Fixture) {
  const fetch = async () => Response.json({ stopped: true });
  return new SubagentService(
    harness.db,
    f.messaging,
    new RunService(harness.db, fetch),
    harness.root,
    fetch,
    f.store
  );
}
async function start(f: Fixture) {
  const execution = await f.service.runNow(f.botId, f.routineId, randomUUID());
  const root = (
    await harness.db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } })
  ).runId!;
  expect((await f.worker.claim(f.botId))?.runId).toBe(root);
  return root;
}
async function finish(root: string) {
  await harness.db.run.update({
    where: { id: root },
    data: { status: "completed", completedAt: new Date() },
  });
  await harness.db.inboxEvent.updateMany({
    where: { runId: root },
    data: { status: "completed", completedAt: new Date() },
  });
  await harness.db.botRunLease.deleteMany({ where: { runId: root } });
}

integration(
  "actual Stop during a routine continuation stops its original context and fences later callbacks",
  async () => {
    const f = await harness.fixture();
    try {
      const root = await start(f);
      await finish(root);
      await callback(f, root);
      const continuation = await f.worker.claim(f.botId);
      expect(continuation?.origin).toBe("routine");
      await Effect.runPromise(stops(f).stopRun(continuation!.runId));
      expect(
        (await harness.db.run.findUniqueOrThrow({ where: { id: root } })).requestStoppedAt
      ).not.toBeNull();
      expect((await callback(f, root)).delivered).toBe(false);
      expect(await f.worker.claim(f.botId)).toBeNull();
      await f.worker.recoverRoutineExecutions();
      expect(
        (await harness.db.routineExecution.findUniqueOrThrow({ where: { runId: root } })).status
      ).toBe("cancelled");
    } finally {
      await f.cleanup();
    }
  }
);

integration(
  "Stop of a routine root fences delivery by a parent handoff that was already claimed",
  async () => {
    const f = await harness.fixture();
    try {
      const root = await start(f);
      const handoff = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Result ready",
      });
      await finish(root);
      expect((await f.worker.claim(f.botId))?.runId).toBe(handoff.run_id);
      await Effect.runPromise(stops(f).stopRun(root));
      await expect(
        f.messaging.sendVisible(context(f, handoff.run_id, "background_revival"), {
          type: "text",
          content: "Obsolete routine result",
        })
      ).rejects.toMatchObject({ code: "request_stopped" });
    } finally {
      await f.cleanup();
    }
  }
);

integration(
  "ordinary claimed parent handoffs still deliver when the routine has not been stopped",
  async () => {
    const f = await harness.fixture();
    try {
      const root = await start(f);
      const handoff = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Result ready",
      });
      await finish(root);
      expect((await f.worker.claim(f.botId))?.runId).toBe(handoff.run_id);
      const result = await f.messaging.sendVisible(
        context(f, handoff.run_id, "background_revival"),
        {
          type: "text",
          content: "Current routine result",
        }
      );
      expect(result.acknowledgement).toMatchObject({ sent: true });
    } finally {
      await f.cleanup();
    }
  }
);

integration(
  "stopping a completed continuation also stops workers still owned by its original routine",
  async () => {
    const f = await harness.fixture();
    let childBotId: string | undefined;
    try {
      const root = await start(f);
      await finish(root);
      await callback(f, root);
      const continuation = await f.worker.claim(f.botId);
      await finish(continuation!.runId);
      const child = await harness.db.bot.create({
        data: {
          name: "Legacy routine worker",
          status: "active",
          defaultDirectory: harness.root,
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      childBotId = child.id;
      const childRun = await harness.db.run.create({
        data: {
          botId: child.id,
          conversationId: child.conversation!.id,
          userMessageId: randomUUID(),
          origin: "agent",
          status: "running",
        },
      });
      const worker = await harness.db.subagent.create({
        data: {
          parentBotId: f.botId,
          childBotId: child.id,
          parentRunId: root,
          parentChannelId: f.channelId,
          currentRunId: childRun.id,
          launchCallId: randomUUID(),
          description: "Legacy delegated work",
          prompt: "Read only",
          subagentType: "executor",
          status: "running",
          outputPath: "/tmp/legacy-routine-worker",
        },
      });
      await harness.db.subagentAttempt.create({
        data: {
          subagentId: worker.id,
          parentRunId: root,
          parentChannelId: f.channelId,
          parentToolCallId: worker.launchCallId,
          childRunId: childRun.id,
          description: worker.description,
          prompt: worker.prompt,
          status: "running",
        },
      });
      await Effect.runPromise(stops(f).stopRun(continuation!.runId));
      expect(
        (await harness.db.run.findUniqueOrThrow({ where: { id: root } })).requestStoppedAt
      ).not.toBeNull();
      expect(
        (await harness.db.subagent.findUniqueOrThrow({ where: { id: worker.id } })).status
      ).toBe("stopped");
      expect((await harness.db.run.findUniqueOrThrow({ where: { id: childRun.id } })).status).toBe(
        "cancelled"
      );
    } finally {
      if (childBotId) await harness.db.bot.delete({ where: { id: childBotId } });
      await f.cleanup();
    }
  }
);

integration(
  "concurrent repair callers cover multiple pages exactly once without altering protected rows",
  async () => {
    const { repairRoutineScheduling } = await import("../../../scripts/repair-routine-scheduling");
    const f = await harness.fixture();
    try {
      const now = new Date("2026-11-12T12:00:00Z"),
        next = new Date("2026-11-13T03:00:00Z");
      const ids = Array.from({ length: 205 }, () => randomUUID());
      await harness.db.routine.createMany({
        data: ids.map((id, i) => ({
          id,
          botId: f.botId,
          slug: `maintenance-${i}`,
          name: "Legacy imported definition",
          prompt: "Read-only test",
          trigger: {
            type: "group",
            listeners: [
              { type: "cron", schedule: "0 3 * * *" },
              { type: "cron", schedule: "0 18 * * *" },
            ],
          },
          scheduleText: "0 3 * * *",
          scheduleKind: "cron",
          cronExpression: "0 3 * * *",
          timezone: "UTC",
          createdAt: now,
          nextRunAt: next,
          scheduleAnchorAt: null,
        })),
      });
      await harness.db.routine.update({ where: { id: ids[0] }, data: { enabled: false } });
      await harness.db.routine.update({ where: { id: ids[1] }, data: { deletedAt: now } });
      await harness.db.routine.update({
        where: { id: ids[2] },
        data: { validationError: "Test invalid definition" },
      });
      const results = await Promise.all([
        repairRoutineScheduling(harness.db, { now, apply: true }),
        repairRoutineScheduling(harness.db, { now, apply: true }),
      ]);
      expect(results.flatMap((result) => result.errors)).toEqual([]);
      const changed = results.flatMap((result) => result.changes.map((change) => change.id));
      expect(changed.length).toBe(202);
      expect(new Set(changed).size).toBe(202);
      expect(
        await harness.db.routine.count({
          where: {
            id: { in: ids.slice(3) },
            nextRunAt: new Date("2026-11-12T18:00:00Z"),
            scheduleAnchorAt: now,
          },
        })
      ).toBe(202);
      expect(
        await harness.db.routine.count({
          where: { id: { in: ids.slice(0, 3) }, nextRunAt: next, scheduleAnchorAt: null },
        })
      ).toBe(3);
      expect((await repairRoutineScheduling(harness.db, { now, apply: true })).changes).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  15_000
);

integration(
  "a claimed routine handoff can notify a peer normally but cannot publish after Stop",
  async () => {
    const f = await harness.fixture(),
      peer = await harness.fixture();
    try {
      const root = await start(f);
      const handoff = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Notify the peer of the result",
      });
      await finish(root);
      expect((await f.worker.claim(f.botId))?.runId).toBe(handoff.run_id);
      await f.messaging.sendToAgent(context(f, handoff.run_id, "background_revival"), {
        target_id: peer.botId,
        message: "Current result",
      });
      const accepted = await harness.db.inboxEvent.count({ where: { botId: peer.botId } });
      expect(accepted).toBe(1);
      await Effect.runPromise(stops(f).stopRun(root));
      await expect(
        f.messaging.sendToAgent(context(f, handoff.run_id, "background_revival"), {
          target_id: peer.botId,
          message: "Obsolete result",
        })
      ).rejects.toMatchObject({ code: "request_stopped" });
      expect(await harness.db.inboxEvent.count({ where: { botId: peer.botId } })).toBe(accepted);
    } finally {
      await peer.cleanup();
      await f.cleanup();
    }
  }
);
