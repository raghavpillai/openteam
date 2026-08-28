import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalRoutineExecutionStatus, WakeWorker } from "../src/worker";

describe("routine execution restart reconciliation", () => {
  test("maps terminal linked runs without terminating live runs", () => {
    expect(terminalRoutineExecutionStatus("completed")).toBe("completed");
    expect(terminalRoutineExecutionStatus("failed")).toBe("failed");
    expect(terminalRoutineExecutionStatus("interrupted")).toBe("failed");
    expect(terminalRoutineExecutionStatus("cancelled")).toBe("cancelled");
    expect(terminalRoutineExecutionStatus("queued")).toBeNull();
    expect(terminalRoutineExecutionStatus("running")).toBeNull();
    expect(terminalRoutineExecutionStatus("waiting_approval")).toBeNull();
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
