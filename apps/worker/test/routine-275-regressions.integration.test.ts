import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRoutineHarness } from "./fixtures/routine-context";
import {
  reconcileRoutineExecution,
  wakeAutomationParent,
} from "../../../packages/messaging/src/automation-results";
import { stopRequestProgress } from "../../../packages/messaging/src/request-progress";
import { groupRoutineState } from "../../../packages/messaging/src/group-routine-state";
import { RoutineService } from "../../../packages/messaging/src/routines";

let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (process.env.OPENTEAM_TEST_DATABASE_URL) harness = await createRoutineHarness();
});
afterAll(async () => {
  await harness?.close();
});
const integration = test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL);
const context = (f: any, runId: string) => ({
  botId: f.botId,
  conversationId: f.conversationId,
  channelId: f.channelId,
  runId,
  callId: randomUUID(),
  origin: "routine" as const,
  isFork: false,
  deliveryId: null,
  replyToMessageId: null,
});
async function execute(f: any) {
  const receipt = await f.service.runNow(f.botId, f.routineId, randomUUID());
  return harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } });
}
async function terminal(runId: string, status: "completed" | "failed" = "completed") {
  await harness.db.run.update({ where: { id: runId }, data: { status, completedAt: new Date() } });
  await harness.db.inboxEvent.updateMany({
    where: { runId },
    data: { status: "completed", completedAt: new Date() },
  });
  await harness.db.botRunLease.deleteMany({ where: { runId } });
}
const callback = (f: any, runId: string, path = `/tmp/${randomUUID()}.log`) =>
  f.messaging.completeShell({
    id: randomUUID(),
    scope: f.botId,
    channelId: f.channelId,
    automationRunId: runId,
    outputPath: path,
    exitCode: 0,
    title: "Finished",
  });

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

integration(
  "group overlap waits for a real background process and releases on its completion",
  async () => {
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
      expect(claimed?.channelId).toBe(g.channelId);
      const path = `${harness.root}/${randomUUID()}.log`;
      const child = Bun.spawn(
        ["sh", "-c", 'read result; printf "%s\\n" "$result" > "$1"', "routine-shell-test", path],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe" }
      );
      try {
        await harness.db.runItem.create({
          data: {
            runId: claimed!.runId,
            kind: "command",
            status: "completed",
            content: {
              shellKind: "background",
              result: { details: { status: "running", outputPath: path } },
            },
          },
        });
        await terminal(claimed!.runId);
        await f.messaging.completeDelivery(claimed!.deliveryId, "completed");
        expect(
          (
            await harness.db.$transaction((tx) =>
              groupRoutineState(tx, execution.channelMessageId!)
            )
          ).active
        ).toBe(true);
        expect(
          (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } }))
            .status
        ).not.toBe("completed");
        child.stdin.write("complete\n");
        child.stdin.end();
        expect(await child.exited).toBe(0);
        expect(await Bun.file(path).text()).toBe("complete\n");
        await f.messaging.completeShell({
          id: randomUUID(),
          scope: f.botId,
          channelId: g.channelId,
          outputPath: path,
          exitCode: 0,
          title: "Finished",
        });
        // The callback itself remains work until consumed; once terminal it releases overlap.
        expect(
          (
            await harness.db.$transaction((tx) =>
              groupRoutineState(tx, execution.channelMessageId!)
            )
          ).active
        ).toBe(true);
        const continuation = await f.worker.claim(f.botId);
        expect(continuation).not.toBeNull();
        await terminal(continuation!.runId);
        expect(
          (
            await harness.db.$transaction((tx) =>
              groupRoutineState(tx, execution.channelMessageId!)
            )
          ).active
        ).toBe(false);
        await f.worker.recoverRoutineExecutions();
        expect(
          (await harness.db.routineExecution.findUniqueOrThrow({ where: { id: receipt.id } }))
            .status
        ).toBe("completed");
      } finally {
        child.kill();
        await child.exited;
      }
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

integration("a folded group shell receipt waits for its processing consumer", async () => {
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
    const path = `${harness.root}/${randomUUID()}.log`;
    await harness.db.runItem.create({
      data: {
        runId: claimed!.runId,
        kind: "command",
        status: "completed",
        content: {
          shellKind: "background",
          result: { details: { status: "running", outputPath: path } },
        },
      },
    });
    await terminal(claimed!.runId);
    await f.messaging.completeDelivery(claimed!.deliveryId, "completed");
    // An older background result consumes the group shell receipt in one batch.
    await harness.db.$transaction((tx) =>
      f.messaging.enqueueWake(tx, {
        botId: f.botId,
        channelId: g.channelId,
        origin: "background_revival",
        type: "shell.completed",
        content: "Other completion",
        clientId: randomUUID(),
        priority: 50,
        revival: { block: "Other completion", subagentType: "shell" },
      })
    );
    await f.messaging.completeShell({
      id: randomUUID(),
      scope: f.botId,
      channelId: g.channelId,
      outputPath: path,
      exitCode: 0,
      title: "Finished",
    });
    const consumer = await f.worker.claim(f.botId);
    expect(consumer).not.toBeNull();
    expect(
      await harness.db.inboxEvent.count({
        where: { botId: f.botId, payload: { path: ["batchedIntoRunId"], equals: consumer!.runId } },
      })
    ).toBe(1);
    expect(
      (await harness.db.$transaction((tx) => groupRoutineState(tx, execution.channelMessageId!)))
        .active
    ).toBe(true);
    await terminal(consumer!.runId);
    expect(
      (await harness.db.$transaction((tx) => groupRoutineState(tx, execution.channelMessageId!)))
        .active
    ).toBe(false);
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

integration(
  "repair preview is read-only; apply preserves pauses, due work and history and is idempotent",
  async () => {
    const { repairRoutineScheduling } = await import("../../../scripts/repair-routine-scheduling");
    const f = await harness.fixture();
    try {
      const now = new Date("2026-11-12T12:00:00Z");
      const affected = await f.service.mutate(f.botId, randomUUID(), null, {
        action: "create",
        name: "Legacy first listener",
        prompt: "Instructions",
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "0 3 * * *" },
            { type: "cron", schedule: "0 18 * * *" },
          ],
        },
      });
      const due = await f.service.mutate(f.botId, randomUUID(), null, {
        action: "create",
        name: "Already due",
        prompt: "Instructions",
        schedule: "@every 5m",
      });
      const stale = new Date("2026-11-13T03:00:00Z"),
        alreadyDue = new Date(now.getTime() - 300_000);
      await harness.db.routine.update({
        where: { id: String(affected.id) },
        data: { createdAt: now, scheduleAnchorAt: null, nextRunAt: stale },
      });
      await harness.db.routine.update({
        where: { id: String(due.id) },
        data: { scheduleAnchorAt: null, nextRunAt: alreadyDue },
      });
      const paused = await f.read();
      const preview = await repairRoutineScheduling(harness.db, { now });
      expect(preview.errors).toEqual([]);
      expect(preview.changes.find((change) => change.id === affected.id)?.to).toBe(
        "2026-11-12T18:00:00.000Z"
      );
      expect(
        (await harness.db.routine.findUniqueOrThrow({ where: { id: String(affected.id) } }))
          .nextRunAt
      ).toEqual(stale);
      const applied = await repairRoutineScheduling(harness.db, { now, apply: true });
      expect(applied.errors).toEqual([]);
      expect(
        (
          await harness.db.routine.findUniqueOrThrow({ where: { id: String(affected.id) } })
        ).nextRunAt?.toISOString()
      ).toBe("2026-11-12T18:00:00.000Z");
      expect(
        (await harness.db.routine.findUniqueOrThrow({ where: { id: String(due.id) } })).nextRunAt
      ).toEqual(alreadyDue);
      expect(await f.read()).toEqual(paused);
      expect(
        await harness.db.routineExecution.count({ where: { routine: { botId: f.botId } } })
      ).toBe(0);
      expect((await repairRoutineScheduling(harness.db, { now, apply: true })).changes).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }
);
