import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOwesUserDelivery,
  terminalGroupRoutineExecutionStatus,
  terminalRoutineExecutionStatus,
  WakeWorker,
} from "../src/worker";

describe("routine execution restart reconciliation", () => {
  test("redrives only interrupted wakes that owe the user a visible delivery", () => {
    for (const origin of [
      "user",
      "bootstrap",
      "connector",
      "handoff_resume",
      "broadcast",
    ] as const) {
      expect(runOwesUserDelivery(origin)).toBe(true);
    }
    for (const origin of ["agent", "group", "routine", "event", "background_revival"] as const) {
      expect(runOwesUserDelivery(origin)).toBe(false);
    }
  });

  test("maps terminal linked runs without terminating live runs", () => {
    expect(terminalRoutineExecutionStatus("completed")).toBe("completed");
    expect(terminalRoutineExecutionStatus("failed")).toBe("failed");
    expect(terminalRoutineExecutionStatus("interrupted")).toBe("failed");
    expect(terminalRoutineExecutionStatus("cancelled")).toBe("cancelled");
    expect(terminalRoutineExecutionStatus("queued")).toBeNull();
    expect(terminalRoutineExecutionStatus("running")).toBeNull();
    expect(terminalRoutineExecutionStatus("waiting_approval")).toBeNull();
  });

  test("maps terminal group rounds and preserves live rounds", () => {
    expect(terminalGroupRoutineExecutionStatus("queued", [])).toBeNull();
    expect(terminalGroupRoutineExecutionStatus("running", ["completed"])).toBeNull();
    expect(terminalGroupRoutineExecutionStatus("failed", ["completed"])).toBe("failed");
    expect(terminalGroupRoutineExecutionStatus("completed", [])).toBe("completed");
    expect(terminalGroupRoutineExecutionStatus("completed", ["completed", "failed"])).toBe(
      "completed"
    );
    expect(terminalGroupRoutineExecutionStatus("completed", ["failed", "skipped"])).toBe("failed");
  });

  test("repairs a terminal group execution and its durable ledger", async () => {
    const completedAt = new Date("2026-08-31T12:00:00.000Z");
    const executionUpdates: unknown[] = [];
    const routineUpdates: unknown[] = [];
    const events: unknown[] = [];
    const tx = {
      routineExecution: {
        findUnique: async () => ({
          id: "execution-1",
          routineId: "routine-1",
          kind: "scheduled",
          status: "running",
          scheduledFor: new Date("2026-08-31T11:55:00.000Z"),
          enqueuedAt: new Date("2026-08-31T11:55:01.000Z"),
          startedAt: new Date("2026-08-31T11:55:02.000Z"),
          routine: { channelId: "channel-1", runLedger: [] },
        }),
        updateMany: async (input: unknown) => {
          executionUpdates.push(input);
          return { count: 1 };
        },
      },
      channelRound: {
        findFirst: async () => ({
          status: "completed",
          completedAt,
          deliveries: [{ status: "failed" }, { status: "skipped" }],
        }),
      },
      routine: {
        update: async (input: unknown) => {
          routineUpdates.push(input);
          return {};
        },
      },
      event: {
        create: async (input: unknown) => {
          events.push(input);
          return {};
        },
      },
    };
    const worker = Object.create(WakeWorker.prototype) as WakeWorker;
    Object.defineProperty(worker, "prisma", {
      value: { $transaction: async (work: (client: typeof tx) => Promise<void>) => work(tx) },
    });

    await (
      worker as unknown as {
        recoverGroupRoutineExecution(executionId: string, rootMessageId: string): Promise<void>;
      }
    ).recoverGroupRoutineExecution("execution-1", "message-1");

    expect(executionUpdates).toHaveLength(1);
    expect(executionUpdates[0]).toMatchObject({
      data: {
        status: "failed",
        completedAt,
        error: { code: "group_routine_delivery_failed" },
      },
    });
    expect(routineUpdates[0]).toMatchObject({
      data: {
        runLedger: [
          {
            id: "execution-1",
            trigger: "schedule",
            finishedAt: completedAt.getTime(),
            status: "error",
            errorKind: "group_routine_delivery_failed",
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({
      data: { topic: "routine.execution.failed", entityId: "execution-1" },
    });
  });

  test("repairs a nonterminal execution whose linked run died during restart", async () => {
    const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;
    if (!databaseUrl) return;

    const temporary = await mkdtemp(join(tmpdir(), "openbot-routine-recovery-"));
    const workspace = join(temporary, "workspace");
    process.env.DATABASE_URL = databaseUrl;
    process.env.OPENBOT_WORKSPACE_ROOT = workspace;
    process.env.OPENBOT_AGENT_DATA_ROOT = join(temporary, "agent-data");
    await mkdir(workspace, { recursive: true });
    const worker = new WakeWorker();
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const routineId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    try {
      await worker.prisma.bot.create({
        data: {
          id: botId,
          name: "Routine recovery",
          defaultDirectory: join(workspace, botId),
          status: "active",
          onboardingStatus: "completed",
          conversation: { create: { id: conversationId } },
        },
      });
      const routine = await worker.prisma.routine.create({
        data: {
          id: routineId,
          botId,
          slug: "restart-probe",
          name: "Restart probe",
          prompt: "Record restart recovery.",
          trigger: { type: "cron", schedule: "@daily" },
          scheduleText: "@daily",
          scheduleKind: "cron",
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          runLedger: [
            {
              id: executionId,
              trigger: "schedule",
              startedAt: Date.now(),
              finishedAt: null,
              status: "running",
            },
          ],
        },
      });
      const revision = await worker.prisma.routineRevision.create({
        data: {
          routineId,
          revision: 1,
          name: routine.name,
          prompt: routine.prompt,
          scheduleText: routine.scheduleText,
          scheduleKind: routine.scheduleKind,
          cronExpression: routine.cronExpression,
          intervalSeconds: routine.intervalSeconds,
          timezoneMode: routine.timezoneMode,
          timezone: routine.timezone,
          enabled: true,
          source: "test",
        },
      });
      await worker.prisma.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          userMessageId: crypto.randomUUID(),
          origin: "routine",
          status: "interrupted",
          completedAt: new Date(),
          error: { code: "runtime_restart", message: "Runtime restarted" },
        },
      });
      await worker.prisma.routineExecution.create({
        data: {
          id: executionId,
          routineId,
          routineRevisionId: revision.id,
          runId,
          kind: "scheduled",
          status: "running",
          dedupeKey: `restart:${executionId}`,
          scheduledFor: new Date(),
          enqueuedAt: new Date(),
          startedAt: new Date(),
        },
      });
      await worker.agentData.initializeBot(botId);
      await worker.agentData.writeRoutine(botId, routineId);

      await (
        worker as unknown as { recoverRoutineExecutions(): Promise<void> }
      ).recoverRoutineExecutions();

      expect(
        await worker.prisma.routineExecution.findUniqueOrThrow({ where: { id: executionId } })
      ).toMatchObject({ status: "failed" });
      const runs = JSON.parse(
        await readFile(
          join(worker.agentData.botDirectory(botId), "automations", routine.slug, "runs.json"),
          "utf8"
        )
      ) as Array<Record<string, unknown>>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: executionId,
        trigger: "schedule",
        status: "error",
        errorKind: "runtime_restart",
      });
      expect(runs[0]).not.toHaveProperty("coalescedRunIds");
    } finally {
      await worker.prisma.bot.deleteMany({ where: { id: botId } });
      await worker.prisma.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
