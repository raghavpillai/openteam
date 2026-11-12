import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ToolContext } from "@openteam/messaging";
import { createRoutineHarness } from "./fixtures/routine-context";
import {
  reconcileRoutineExecution,
  wakeAutomationParent,
} from "../../../packages/messaging/src/automation-results";
import { groupRoutineState } from "../../../packages/messaging/src/group-routine-state";
import { stopRequestProgress } from "../../../packages/messaging/src/request-progress";
import { RoutineService } from "../../../packages/messaging/src/routines";
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
    const f = await harness.fixture();
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
  "Stop of a routine root fences delivery by a parent handoff that was already claimed",
  async () => {
    const f = await harness.fixture();
    try {
      const root = await start(f);
      const handoff = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Result ready",
      });
      await terminal(root);
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
      await terminal(root);
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
      await terminal(root);
      await callback(f, root);
      const continuation = await f.worker.claim(f.botId);
      await terminal(continuation!.runId);
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
  "a claimed routine handoff can notify a peer normally but cannot publish after Stop",
  async () => {
    const f = await harness.fixture(),
      peer = await harness.fixture();
    try {
      const root = await start(f);
      const handoff = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Notify the peer of the result",
      });
      await terminal(root);
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

integration("Stop fences late shell callbacks and parent handoffs", async () => {
  const f = await harness.fixture();
  try {
    const root = (await execute(f)).runId!;
    await f.worker.claim(f.botId);
    await harness.db.runItem.create({
      data: {
        runId: root,
        kind: "command",
        status: "completed",
        content: {
          shellKind: "background",
          result: { details: { status: "running", outputPath: "/tmp/stopped-routine-shell.log" } },
        },
      },
    });
    await harness.db.$transaction((tx) => stopRequestProgress(tx, f.botId, root));
    expect((await callback(f, root)).delivered).toBe(false);
    await expect(
      wakeAutomationParent(f.messaging, context(f, root), { message: "Obsolete result" })
    ).rejects.toMatchObject({ code: "wake_parent_unavailable" });
    await f.worker.recoverRoutineExecutions();
    expect(
      (await harness.db.routineExecution.findUniqueOrThrow({ where: { runId: root } })).status
    ).toBe("cancelled");
    expect(await f.worker.claim(f.botId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

integration(
  "a callback queued before handoff is cancelled without another model turn",
  async () => {
    const f = await harness.fixture();
    try {
      const root = (await execute(f)).runId!;
      await harness.db.run.update({ where: { id: root }, data: { status: "running" } });
      await harness.db.inboxEvent.updateMany({
        where: { runId: root },
        data: { status: "completed" },
      });
      expect((await callback(f, root)).delivered).toBe(true);
      const wake = await wakeAutomationParent(f.messaging, context(f, root), {
        message: "Complete",
      });
      await terminal(root);
      expect((await f.worker.claim(f.botId))?.runId).toBe(wake.run_id);
      await terminal(wake.run_id);
      expect(await f.worker.claim(f.botId)).toBeNull();
      expect(
        await harness.db.run.count({
          where: {
            botId: f.botId,
            origin: "routine",
            error: { path: ["code"], equals: "automation_context_ended" },
          },
        })
      ).toBe(1);
    } finally {
      await f.cleanup();
    }
  }
);

integration("Stop cancels a parent handoff still waiting in the queue", async () => {
  const f = await harness.fixture();
  try {
    const root = (await execute(f)).runId!;
    await f.worker.claim(f.botId);
    const wake = await wakeAutomationParent(f.messaging, context(f, root), {
      message: "Result awaiting delivery",
    });
    await terminal(root);
    await harness.db.$transaction((tx) => stopRequestProgress(tx, f.botId, root));
    expect(await f.worker.claim(f.botId)).toBeNull();
    expect((await harness.db.run.findUniqueOrThrow({ where: { id: wake.run_id } })).status).toBe(
      "cancelled"
    );
  } finally {
    await f.cleanup();
  }
});

integration("unknown callback context never falls into the foreground", async () => {
  const f = await harness.fixture();
  try {
    expect((await callback(f, randomUUID())).delivered).toBe(false);
    expect((await callback(f, "not-a-uuid")).delivered).toBe(false);
    expect(await f.worker.claim(f.botId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

integration("a folded completion receipt cannot mask a failed processing turn", async () => {
  const f = await harness.fixture();
  try {
    const execution = await execute(f),
      root = execution.runId!;
    await terminal(root);
    await callback(f, root);
    await callback(f, root);
    const pending = await harness.db.inboxEvent.findMany({
      where: { botId: f.botId, status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    for (const [n, wake] of pending.entries()) {
      const time = new Date(Date.now() - 2000 + n * 500);
      await harness.db.inboxEvent.update({ where: { id: wake.id }, data: { createdAt: time } });
      await harness.db.run.update({ where: { id: wake.runId }, data: { createdAt: time } });
    }
    const claimed = await f.worker.claim(f.botId);
    expect(claimed).not.toBeNull();
    expect(
      await harness.db.run.count({
        where: { id: { in: pending.map((w) => w.runId) }, status: "completed" },
      })
    ).toBe(1);
    await terminal(claimed!.runId, "failed");
    await harness.db.$transaction((tx) => reconcileRoutineExecution(tx, claimed!.runId));
    expect(
      (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } })).status
    ).toBe("failed");
  } finally {
    await f.cleanup();
  }
});

integration(
  "periodic recovery retries a committed group round after its handoff failed",
  async () => {
    const f = await harness.fixture();
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
      expect(
        (
          await harness.db.channelRound.findFirstOrThrow({
            where: { rootMessageId: execution.channelMessageId! },
          })
        ).status
      ).toBe("running");
      expect(await harness.db.run.count({ where: { channelId: g.channelId } })).toBe(1);
    } finally {
      await f.cleanup();
    }
  }
);

integration("Stop releases a completed group turn's outstanding shell wait", async () => {
  const f = await harness.fixture();
  try {
    const g = await f.group({ type: "cron", schedule: "@every 5m" });
    const receipt = await f.service.runNowOwner(
      { kind: "group", id: g.channelId },
      g.routineId,
      randomUUID()
    );
    const execution = await harness.db.routineExecution.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    const claimed = await f.worker.claim(f.botId);
    await harness.db.runItem.create({
      data: {
        runId: claimed!.runId,
        kind: "command",
        status: "completed",
        content: {
          shellKind: "background",
          result: { details: { status: "running", outputPath: "/tmp/stopped-group-shell.log" } },
        },
      },
    });
    await terminal(claimed!.runId);
    await f.messaging.completeDelivery(claimed!.deliveryId, "completed");
    expect(
      (await harness.db.$transaction((tx) => groupRoutineState(tx, execution.channelMessageId!)))
        .active
    ).toBe(true);
    await harness.db.$transaction((tx) => stopRequestProgress(tx, f.botId, claimed!.runId));
    expect(
      (await harness.db.$transaction((tx) => groupRoutineState(tx, execution.channelMessageId!)))
        .active
    ).toBe(false);
    await f.worker.recoverRoutineExecutions();
    expect(
      (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } })).status
    ).toBe("completed");
  } finally {
    await f.cleanup();
  }
});

// The budget includes seeding 101 real wakes and executions; it is not a runtime latency assertion.
integration(
  "recovery rotates past 100 live executions",
  async () => {
    const f = await harness.fixture();
    try {
      const execution = await execute(f);
      const original = await harness.db.routineExecution.findUniqueOrThrow({
        where: { id: execution.id },
      });
      const ids = Array.from(
        { length: 101 },
        (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`
      );
      // Live entries use real executions/runs; distinct routines are unnecessary to
      // exercise the recovery scan's fairness across independently linked contexts.
      for (const [n, id] of ids.entries()) {
        const wake = await harness.db.$transaction((tx) =>
          f.messaging.enqueueWake(tx, {
            botId: f.botId,
            channelId: f.channelId,
            origin: "routine",
            type: "routine.manual",
            content: "Recovery",
            clientId: `recovery-${id}`,
            priority: 40,
          })
        );
        await harness.db.routineExecution.create({
          data: {
            id,
            routineId: f.routineId,
            routineRevisionId: original.routineRevisionId,
            kind: "test",
            dedupeKey: `recovery-${id}`,
            scheduledFor: new Date(),
            runId: wake.run.id,
          },
        });
        if (n === 100) await terminal(wake.run.id);
      }
      await f.worker.recoverRoutineExecutions();
      expect(
        (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: ids[100] } })).status
      ).toBe("queued");
      await f.worker.recoverRoutineExecutions();
      expect(
        (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: ids[100] } })).status
      ).toBe("completed");
    } finally {
      await f.cleanup();
    }
  },
  30_000
);

integration("one broken follow-up does not block another bot's settlement", async () => {
  const fixtures = [
    await harness.fixture({ trigger: { type: "webhook" }, enabled: true }),
    await harness.fixture({ trigger: { type: "webhook" }, enabled: true }),
  ];
  try {
    for (const f of fixtures) {
      await f.service.dispatchEvent(
        { kind: "bot", id: f.botId },
        { id: randomUUID(), source: "webhook", kind: "received", text: "Event" }
      );
      const root = await harness.db.routineExecution.findFirstOrThrow({
        where: { routineId: f.routineId },
      });
      await terminal(root.runId!);
    }
    const ordered = await harness.db.routineExecution.findMany({
      where: { routineId: { in: fixtures.map((f) => f.routineId) } },
      orderBy: { id: "asc" },
    });
    const bad = fixtures.find((f) => f.routineId === ordered[0]!.routineId)!;
    const good = fixtures.find((f) => f !== bad)!;
    await bad.service.dispatchEvent(
      { kind: "bot", id: bad.botId },
      { id: randomUUID(), source: "webhook", kind: "received", text: "Next event" }
    );
    good.worker.routines = new RoutineService(
      harness.db,
      {
        enqueueWake: async (tx, input) => {
          if (input.botId === bad.botId) throw new Error("Transient follow-up launch failure");
          return good.messaging.enqueueWake(tx, input);
        },
      },
      good.store
    );
    await good.worker.recoverRoutineExecutions();
    expect(
      (await harness.db.routineExecution.findFirstOrThrow({ where: { routineId: good.routineId } }))
        .status
    ).toBe("completed");
    expect(
      (
        await harness.db.routineExecution.findFirstOrThrow({
          where: { routineId: bad.routineId, runId: { not: null } },
        })
      ).status
    ).toBe("queued");
    good.worker.routines = good.service;
    await good.worker.recoverRoutineExecutions();
    expect(
      (
        await harness.db.routineExecution.findFirstOrThrow({
          where: { routineId: bad.routineId, runId: { not: null } },
          orderBy: { createdAt: "asc" },
        })
      ).status
    ).toBe("completed");
  } finally {
    for (const f of fixtures) await f.cleanup();
  }
});

// Group shell receipts settle with the outcome of the turn that actually processed them.
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
