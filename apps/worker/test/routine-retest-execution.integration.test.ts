import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRoutineHarness } from "./fixtures/routine-context";
import { groupRoutineState } from "../../../packages/messaging/src/group-routine-state";

let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (process.env.OPENTEAM_TEST_DATABASE_URL) harness = await createRoutineHarness();
});
afterAll(async () => {
  await harness?.close();
});
const integration = test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL);

for (const layout of ["single", "folded", "legacy-folded"] as const) {
  for (const status of ["completed", "failed"] as const) {
    integration(
      `${layout} group shell receipt records its actual processing turn's ${status} outcome`,
      async () => {
        const f = await harness.fixture();
        try {
          const group = await f.group({ type: "cron", schedule: "@every 5m" });
          const receipt = await f.service.runNowOwner(
            { kind: "group", id: group.channelId },
            group.routineId,
            randomUUID()
          );
          const execution = await harness.db.routineExecution.findUniqueOrThrow({
            where: { id: receipt.id },
          });
          const root = await f.worker.claim(f.botId);
          const outputPath = `${harness.root}/batch-${randomUUID()}.log`;
          await harness.db.runItem.create({
            data: {
              runId: root.runId,
              kind: "command",
              status: "completed",
              content: {
                shellKind: "background",
                result: { details: { status: "running", outputPath } },
              },
            },
          });
          await harness.db.run.update({
            where: { id: root.runId },
            data: { status: "completed", completedAt: new Date() },
          });
          await harness.db.inboxEvent.updateMany({
            where: { runId: root.runId },
            data: { status: "completed", completedAt: new Date() },
          });
          await harness.db.botRunLease.deleteMany({ where: { runId: root.runId } });
          await f.messaging.completeDelivery(root.deliveryId, "completed");
          expect(
            (
              await harness.db.$transaction((tx) =>
                groupRoutineState(tx, execution.channelMessageId!)
              )
            ).active
          ).toBe(true);
          // A preceding completion consumes the group shell receipt in a real claim batch.
          if (layout !== "single")
            await harness.db.$transaction((tx) =>
              f.messaging.enqueueWake(tx, {
                botId: f.botId,
                channelId: group.channelId,
                origin: "background_revival",
                type: "shell.completed",
                content: "Earlier completion",
                clientId: randomUUID(),
                priority: 50,
                revival: { block: "Earlier completion", subagentType: "shell" },
              })
            );
          await f.messaging.completeShell({
            id: randomUUID(),
            scope: f.botId,
            channelId: group.channelId,
            outputPath,
            exitCode: 0,
            title: "Finished",
          });
          const consumer = await f.worker.claim(f.botId);
          expect(consumer).not.toBeNull();
          expect(
            await harness.db.inboxEvent.count({
              where: {
                botId: f.botId,
                payload: { path: ["batchedIntoRunId"], equals: consumer.runId },
              },
            })
          ).toBe(layout === "single" ? 0 : 1);
          expect(
            (
              await harness.db.$transaction((tx) =>
                groupRoutineState(tx, execution.channelMessageId!)
              )
            ).active
          ).toBe(true);
          if (layout === "legacy-folded") {
            const folded = await harness.db.inboxEvent.findFirstOrThrow({
              where: {
                botId: f.botId,
                payload: { path: ["batchedIntoRunId"], equals: consumer.runId },
              },
            });
            const payload = { ...(folded.payload as Record<string, any>) };
            delete payload.batchedIntoRunId;
            await harness.db.inboxEvent.update({ where: { id: folded.id }, data: { payload } });
          }
          await harness.db.run.update({
            where: { id: consumer.runId },
            data: {
              status,
              completedAt: new Date(),
              ...(status === "failed" ? { error: { code: "processing_turn_failed" } } : {}),
            },
          });
          await harness.db.inboxEvent.updateMany({
            where: { runId: consumer.runId },
            data: { status: "completed", completedAt: new Date() },
          });
          await harness.db.botRunLease.deleteMany({ where: { runId: consumer.runId } });
          await f.worker.recoverRoutineExecutions();
          expect(
            (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } }))
              .status
          ).toBe(status);
        } finally {
          await f.cleanup();
        }
      }
    );
  }
}
