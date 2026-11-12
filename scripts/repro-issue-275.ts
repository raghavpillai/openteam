// Characterizes issue #275 on unmodified production code. Assertions deliberately
// describe the reported bug; this is an investigation script, not a regression test.
// Run: bun scripts/repro-issue-275.ts
// Optional real-DB sync/dispatch check: set OPENTEAM_TEST_DATABASE_URL to a
// disposable database with the current Prisma schema already applied.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../packages/db/src/index";
import { AgentDataStore } from "../packages/messaging/src/agent-data";
import { parseAutomationFile, writeAutomationFiles } from "../packages/messaging/src/automation-files";
import { nextRoutineTriggerRun, RoutineService } from "../packages/messaging/src/routines";

const morning = { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" };
const evening = { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" };
const createdAt = new Date("2026-11-10T22:00:00Z");
const root = await mkdtemp(join(tmpdir(), "openteam-275-files-"));
const botId = randomUUID();
const botDirectory = join(root, "agents", botId);
const input = {
  name: "Two schedule check",
  prompt: "Send the message 'two-schedule check ran'.",
  trigger: { type: "group", listeners: [morning, evening] },
  triggerPresentation: null,
  scheduleText: morning.schedule,
  enabled: true,
  provenance: "user",
  createdAt,
  lastRunAt: null,
  pendingNotices: [],
  raisedNotices: [],
};

try {
  for (const [slug, trigger] of [
    ["original", input.trigger],
    ["reversed", { type: "group", listeners: [evening, morning] }],
    ["single", evening],
  ] as const) {
    const { directory } = await writeAutomationFiles(botDirectory, {
      ...input, slug, trigger, scheduleText: slug === "single" ? evening.schedule : input.scheduleText,
    });
    const path = join(directory, "automation.json");
    const parsed = await parseAutomationFile(path, await readFile(path, "utf8"), "America/New_York");
    assert(parsed.schedule);
    const expected = nextRoutineTriggerRun(parsed.trigger, parsed.schedule, createdAt);
    assert.equal(expected.toISOString(), "2026-11-10T23:09:00.000Z");
    assert.equal(parsed.nextRunAt?.toISOString(), slug === "original"
      ? "2026-11-11T08:00:00.000Z" : expected.toISOString());
    console.log(JSON.stringify({ case: slug, fileSyncNextRun: parsed.nextRunAt, expectedNextRun: expected }));
    await rm(directory, { recursive: true });
  }

  const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.log("Parser reproduction confirmed. Set OPENTEAM_TEST_DATABASE_URL for real-DB verification.");
  } else {
    const db = createPrismaClient(databaseUrl);
    const conversationId = randomUUID();
    const channelId = randomUUID();
    const store = new AgentDataStore(db, { root, workspaceRoot: root });
    let wakeCount = 0;
    const scheduler = new RoutineService(db, {
      enqueueWake: async (tx) => {
        wakeCount++;
        // Replace only model execution with a persisted run. Scheduling, file
        // reconciliation, revisions, executions, and events use real code/DB.
        const run = await tx.run.create({ data: {
          botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine",
        } });
        return { run };
      },
    }, store);
    let routineId: string | undefined;
    try {
      // This script's database path is intended for an isolated empty database:
      // the batch reconciler enumerates all active bots, just as the worker does.
      assert.equal(await db.bot.count(), 0, "Use an empty disposable test database");
      await db.bot.create({ data: {
        id: botId, name: "Issue 275 fixture", status: "active", defaultDirectory: root,
        conversation: { create: { id: conversationId } },
      } });
      await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Issue 275", directKey: `bot:${botId}` } });
      await writeAutomationFiles(botDirectory, { ...input, slug: "two-schedules" });
      const sync = async () => {
        const result = await store.reconcileAutomationFilesBatch(null, 10);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.reconciled, 1);
      };
      const stored = () => db.routine.findUniqueOrThrow({ where: { botId_slug: { botId, slug: "two-schedules" } } });
      await sync();
      let routine = await stored();
      routineId = routine.id;
      assert.equal(routine.nextRunAt?.toISOString(), "2026-11-11T08:00:00.000Z");
      assert.equal(await scheduler.dispatchDue(new Date("2026-11-10T23:12:00Z")), 0);
      assert.equal(await db.routineExecution.count({ where: { routineId } }), 0);
      console.log("Real DB: initial evening schedule skipped; zero executions.");

      assert.equal(await scheduler.dispatchDue(new Date("2026-11-11T08:00:00Z")), 1);
      routine = await stored();
      assert.equal(routine.nextRunAt?.toISOString(), "2026-11-11T23:09:00.000Z");
      assert.equal(routine.lastRunAt?.toISOString(), "2026-11-11T08:00:00.000Z");
      // Finish the first run to rule out overlap as the reason for the next skip.
      await db.routineExecution.updateMany({ where: { routineId }, data: { status: "completed" } });
      await db.run.updateMany({ where: { botId }, data: { status: "completed" } });
      console.log("Real DB: morning dispatch selects the evening schedule correctly.");

      // Repeat the worker's order: reconcile the files, then dispatch due work.
      await sync();
      routine = await stored();
      assert.equal(routine.nextRunAt?.toISOString(), "2026-11-12T08:00:00.000Z");
      assert.equal(await scheduler.dispatchDue(new Date("2026-11-11T23:12:00Z")), 0);
      assert.equal(wakeCount, 1);
      assert.equal(await db.routineExecution.count({ where: { routineId } }), 1);
      console.log("Real DB: subsequent sync overwrites evening with next morning; evening skipped again.");

      // Control: restore the scheduler's earlier result and dispatch without
      // another file sync. This proves the second listener itself is runnable.
      await db.routine.update({ where: { id: routineId }, data: { nextRunAt: new Date("2026-11-11T23:09:00Z") } });
      assert.equal(await scheduler.dispatchDue(new Date("2026-11-11T23:12:00Z")), 1);
      assert.equal(wakeCount, 2);
      assert.equal(await db.routineExecution.count({ where: { routineId } }), 2);
      console.log("Real DB control: evening dispatch works when file sync does not overwrite nextRunAt.");
    } finally {
      if (routineId) {
        await db.routineExecution.deleteMany({ where: { routineId } });
        await db.routineRevision.deleteMany({ where: { routineId } });
        await db.routine.deleteMany({ where: { id: routineId } });
      }
      await db.bot.deleteMany({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.$disconnect();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
