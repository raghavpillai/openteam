import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createRoutineHarness } from "../../../packages/messaging/test/fixtures/routines";
import { RoutineService } from "../../../packages/messaging/src/routines";
import { WakeWorker } from "../src/worker";
import { RunService } from "../../server/src/services/run-service";
import { SubagentService } from "../../server/src/services/subagent/service";

let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (process.env.OPENTEAM_TEST_DATABASE_URL) harness = await createRoutineHarness();
});
afterAll(async () => {
  await harness?.close();
});
const integration = test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL);
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A routine fixture with a database-backed worker around its messaging and routine service. */
async function fixture() {
  const f = await harness.fixture();
  const worker: any = Object.assign(Object.create(WakeWorker.prototype), {
    prisma: harness.db, messaging: f.messaging, routines: f.service, agentData: f.store, workspaceRoot: harness.root,
  });
  return { ...f, worker };
}
const callback = (f: Fixture, runId: string, path = `/tmp/routine-${randomUUID()}.log`) =>
  f.messaging.completeShell({
    id: randomUUID(),
    scope: f.botId,
    channelId: f.channelId,
    automationRunId: runId,
    outputPath: path,
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
async function execute(f: Fixture) {
  const receipt = await f.service.runNow(f.botId, f.routineId, randomUUID());
  return harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } });
}
async function start(f: Fixture) {
  const root = (await execute(f)).runId!;
  expect((await f.worker.claim(f.botId))?.runId).toBe(root);
  return root;
}
async function terminal(runId: string, status: "completed" | "failed" = "completed") {
  await harness.db.run.update({ where: { id: runId }, data: { status, completedAt: new Date() } });
  await harness.db.inboxEvent.updateMany({
    where: { runId },
    data: { status: "completed", completedAt: new Date() },
  });
  await harness.db.botRunLease.deleteMany({ where: { runId } });
}

integration(
  "actual Stop during a routine continuation stops its original context and fences later callbacks",
  async () => {
    const f = await fixture();
    try {
      const root = await start(f);
      await terminal(root);
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
  "periodic recovery retries a committed group round after its handoff failed and settles its failed delivery",
  async () => {
    const f = await fixture();
    try {
      const g = await f.group({ type: "cron", schedule: "@every 5m" });
      const row = await harness.db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      const fault = new RoutineService(
        harness.db,
        {
          enqueueWake: f.messaging.enqueueWake.bind(f.messaging),
          createGroupRound: f.messaging.createGroupRound.bind(f.messaging) as never,
          advanceRound: async () => {
            throw new Error("Transient handoff failure");
          },
        },
        f.store
      );
      expect(await fault.dispatchDue(row.nextRunAt!)).toBe(1);
      await f.worker.recoverRoutineExecutions();
      const execution = await harness.db.routineExecution.findFirstOrThrow({
        where: { routineId: g.routineId },
      });
      const round = await harness.db.channelRound.findFirstOrThrow({
        where: { rootMessageId: execution.channelMessageId! },
      });
      expect(round.status).toBe("running");
      expect(await harness.db.run.count({ where: { channelId: g.channelId } })).toBe(1);
      // Once the room settles with a failed delivery, recovery fails the execution and its ledger.
      await harness.db.run.updateMany({ where: { channelId: g.channelId }, data: { status: "failed", completedAt: new Date() } });
      await harness.db.channelDelivery.updateMany({ where: { roundId: round.id }, data: { status: "failed" } });
      await harness.db.channelRound.update({ where: { id: round.id }, data: { status: "completed", completedAt: new Date() } });
      await f.worker.recoverRoutineExecutions();
      expect(await harness.db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } }))
        .toMatchObject({ status: "failed", error: { code: "group_routine_delivery_failed" } });
      const { runLedger } = await harness.db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      expect((runLedger as any[]).at(-1)).toMatchObject({ id: execution.id, trigger: "schedule", status: "error", errorKind: "group_routine_delivery_failed" });
      expect(await harness.db.event.count({ where: { topic: "routine.execution.failed", entityId: execution.id } })).toBe(1);
    } finally {
      await f.cleanup();
    }
  }
);
