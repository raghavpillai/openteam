// Fault-injection characterization, deliberately asserting current failures.
// Uses unmodified production scheduling/file code and an EMPTY disposable DB.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/repro-issue-275-chaos.ts
import assert from "node:assert/strict";
import { setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPrismaClient } from "../packages/db/src/index";
import { AgentDataStore } from "../packages/messaging/src/agent-data";
import { reconcileRoutineExecution } from "../packages/messaging/src/automation-results";
import { writeAutomationFiles } from "../packages/messaging/src/automation-files";
import { RoutineService } from "../packages/messaging/src/routines";

assert(process.env.OPENTEAM_TEST_DATABASE_URL, "Use an empty disposable test DB");
const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
assert.equal(await db.bot.count(), 0, "Use an empty disposable test DB");
const root = await mkdtemp(join(tmpdir(), "openteam-275-chaos-files-"));
const now = new Date("2026-11-12T12:00:00Z");
const base = new Date("2026-11-12T11:55:00Z");
const cron = (schedule: string) => ({ type: "cron", schedule });
const iso = (value: Date | null) => value?.toISOString() ?? null;
const outcomes: Array<{ name: string; result: string; ms: number }> = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function check(name: string, fn: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  setSystemTime(now);
  const start = performance.now();
  try { await fn(); outcomes.push({ name, result: "confirmed", ms: Math.round(performance.now() - start) }); console.log(`CONFIRMED: ${name}`); }
  catch (error) { outcomes.push({ name, result: "FAILED", ms: Math.round(performance.now() - start) }); console.error(name, error); }
  finally { setSystemTime(); }
}
const definition = (trigger = cron("@every 5m"), createdAt = base) => ({
  name: "Chaos routine", prompt: "Record this occurrence", trigger,
  triggerPresentation: null, scheduleText: String(trigger.schedule ?? "group"), enabled: true,
  provenance: "user", createdAt, lastRunAt: null, pendingNotices: [], raisedNotices: [],
});
async function fixture(trigger: Record<string, any> = cron("@every 5m"), createdAt = base) {
  const botId = randomUUID(), conversationId = randomUUID(), channelId = randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  const botDirectory = store.botDirectory(botId);
  await db.bot.create({ data: { id: botId, name: "Chaos", status: "active", defaultDirectory: root, conversation: { create: { id: conversationId } } } });
  await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Chaos", directKey: `bot:${botId}` } });
  const wakes: any[] = [];
  const host = {
    isTimelineSessionActive: async () => false,
    enqueueWake: async (tx: any, input: any) => {
      wakes.push(input);
      return { run: await tx.run.create({ data: { botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine" } }) };
    },
  };
  const service = new RoutineService(db, host, store);
  const written = await writeAutomationFiles(botDirectory, { ...definition(trigger, createdAt), slug: "chaos" });
  const path = join(written.directory, "automation.json");
  const sync = () => store.reconcileAutomationFilesBatch(null, 100);
  assert.deepEqual((await sync()).warnings, []);
  const read = () => db.routine.findUniqueOrThrow({ where: { botId_slug: { botId, slug: "chaos" } } });
  const routine = await read();
  const complete = async () => {
    await db.routineExecution.updateMany({ where: { routine: { botId } }, data: { status: "completed", completedAt: now } });
    await db.run.updateMany({ where: { botId }, data: { status: "completed", completedAt: now } });
  };
  const cleanup = async () => {
    const routines = await db.routine.findMany({ where: { botId }, select: { id: true } });
    const ids = routines.map(r => r.id);
    const execs = await db.routineExecution.findMany({ where: { routineId: { in: ids } }, select: { id: true } });
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...execs.map(e => e.id)] } } });
    await db.bot.delete({ where: { id: botId } });
    await db.channel.delete({ where: { id: channelId } });
    await rm(botDirectory, { recursive: true, force: true });
  };
  return { botId, store, service, host, path, botDirectory, sync, read, routine, complete, cleanup, wakes };
}

try {
  await db.userTimeZoneSettings.upsert({ where: { id: "global" }, create: { id: "global", detected: "UTC" }, update: { detected: "UTC", override: null } });

  await check("a syntax error soft-deletes an existing routine even though its definition file still exists", async () => {
    const f = await fixture();
    try {
      const original = await readFile(f.path, "utf8");
      await writeFile(f.path, "{ interrupted edit");
      assert.equal((await f.sync()).warnings.length, 1);
      const deleted = await f.read();
      assert(deleted.deletedAt); assert.equal(deleted.enabled, false);
      assert.equal(await f.service.dispatchDue(now), 0);
      await writeFile(f.path, original);
      assert.deepEqual((await f.sync()).warnings, []);
      assert.equal((await f.read()).deletedAt, null);
      assert.equal((await f.read()).revision, f.routine.revision + 1);
      assert.equal((await f.read()).enabled, true);
    } finally { await f.cleanup(); }
  });

  await check("an unreadable automation file blocks the entire sync-then-dispatch pass repeatedly", async () => {
    const bad = await fixture(), good = await fixture();
    try {
      await rename(bad.path, `${bad.path}.saved`);
      await mkdir(bad.path);
      const pass = async () => { await bad.sync(); return good.service.dispatchDue(now); };
      for (let n = 0; n < 3; n++) await assert.rejects(pass, /regular file/);
      assert.equal(await db.routineExecution.count(), 0);
      await rm(bad.path, { recursive: true });
      await rename(`${bad.path}.saved`, bad.path);
      assert.equal(await pass(), 2);
    } finally { await bad.cleanup(); await good.cleanup(); }
  });

  await check("an unreadable runs.json soft-deletes a routine whose automation.json is valid", async () => {
    const f = await fixture();
    try {
      const ledger = join(f.path, "..", "runs.json");
      await rm(ledger);
      await mkdir(ledger);
      assert.equal((await f.sync()).warnings.length, 1);
      assert((await f.read()).deletedAt);
      assert.equal((await f.read()).enabled, false);
    } finally { await f.cleanup(); }
  });

  await check("legacy schedule fallback silently strips all other listeners after a malformed group edit", async () => {
    const f = await fixture({ type: "group", listeners: [cron("@every 5m"), { type: "webhook" }, cron("@every 10m")] });
    try {
      const json = JSON.parse(await readFile(f.path, "utf8"));
      assert.equal(json.schedule, "@every 5m");
      delete json.trigger.listeners[2].schedule;
      await writeFile(f.path, JSON.stringify(json));
      assert.deepEqual((await f.sync()).warnings, []);
      assert.deepEqual((await f.read()).trigger, cron("@every 5m"));
    } finally { await f.cleanup(); }
  });

  await check("crash after dispatch commit but before file projection creates a permanent duplicate-key dispatch trap", async () => {
    const bad = await fixture(), good = await fixture(cron("@every 5m"), new Date("2026-11-12T11:56:00Z"));
    try {
      const crash = new RoutineService(db, bad.host, { writeRoutine: async () => { throw new Error("injected post-commit projection failure"); }, deleteRoutine: async () => {} });
      await assert.rejects(() => crash.dispatchDue(now), /post-commit projection failure/);
      assert.equal(await db.routineExecution.count({ where: { routineId: bad.routine.id } }), 1);
      assert.equal(iso((await bad.read()).nextRunAt), "2026-11-12T12:05:00.000Z");
      await bad.sync();
      assert.equal(iso((await bad.read()).nextRunAt), "2026-11-12T12:00:00.000Z");
      assert.equal((await bad.read()).lastRunAt, null);
      for (let n = 0; n < 3; n++) {
        await assert.rejects(() => good.service.dispatchDue(new Date("2026-11-12T12:02:00Z")), (e: any) => e.code === "P2002");
      }
      assert.equal(await db.routineExecution.count({ where: { routineId: good.routine.id } }), 0);
      assert.equal(await db.routineExecution.count({ where: { routineId: bad.routine.id, status: "failed" } }), 0);
      // Follow the worker's recovery order after the run finishes. Settling
      // the execution and rewriting its files does not repair the erased
      // lastRunAt, so the trap persists even after normal recovery.
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: bad.routine.id } });
      await db.run.update({ where: { id: execution.runId! }, data: { status: "completed", completedAt: now } });
      await db.$transaction(async tx => {
        const settled = await reconcileRoutineExecution(tx, execution.runId!);
        assert(settled);
        await bad.service.afterExecution(tx, settled);
      });
      await bad.store.writeRoutine(bad.botId, bad.routine.id);
      assert.equal((await bad.read()).lastRunAt, null);
      await assert.rejects(() => good.service.dispatchDue(new Date("2026-11-12T12:02:00Z")), (e: any) => e.code === "P2002");
    } finally { await bad.cleanup(); await good.cleanup(); }
  });

  await check("ordinary concurrent reconciliation and dispatch can erase a committed run and poison future dispatch without any crash", async () => {
    const f = await fixture();
    const readReached = deferred(), releaseRead = deferred(), projectionReached = deferred();
    let syncTask: Promise<unknown> | undefined, dispatchTask: Promise<unknown> | undefined;
    try {
      // The hooks only hold a real read/write at controlled barriers. They do
      // not alter data, skip locks, replace SQL, or inject an error.
      const syncDb = db.$extends({ query: { routine: {
        async findUnique({ args, query }) {
          const result = await query(args);
          if (args.where.botId_slug?.botId === f.botId) {
            readReached.resolve();
            await releaseRead.promise;
          }
          return result;
        },
      } } });
      const concurrentStore = new AgentDataStore(syncDb as never, { root, workspaceRoot: root });
      const concurrentScheduler = new RoutineService(db, f.host, {
        writeRoutine: async (botId, id, tx) => {
          projectionReached.resolve(); // dispatch transaction has committed
          await f.store.writeRoutine(botId, id, tx);
        },
        deleteRoutine: (botId, id, tx) => f.store.deleteRoutine(botId, id, tx),
      });
      syncTask = concurrentStore.reconcileAutomationFilesBatch(null, 100);
      await bounded(readReached.promise, "sync read barrier");
      dispatchTask = concurrentScheduler.dispatchDue(now);
      await bounded(projectionReached.promise, "post-commit projection barrier");
      assert.equal(iso((await f.read()).lastRunAt), "2026-11-12T12:00:00.000Z");
      releaseRead.resolve();
      await bounded(Promise.all([syncTask, dispatchTask]), "concurrent tasks");
      assert.equal(await db.routineExecution.count({ where: { routineId: f.routine.id } }), 1);
      assert.equal((await f.read()).lastRunAt, null);
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-12T12:00:00.000Z");
      assert.equal(JSON.parse(await readFile(f.path, "utf8")).lastRunAt, null);
      await assert.rejects(() => f.service.dispatchDue(now), (error: any) => error.code === "P2002");
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([syncTask, dispatchTask]);
      await f.cleanup();
    }
  });

  await check("create rollback leaves an active ghost routine; retrying the same call ID creates a duplicate", async () => {
    const f = await fixture();
    try {
      const callId = randomUUID();
      const input = { action: "create" as const, name: "Ghost create", prompt: "Run", schedule: "@every 5m" };
      const fault = new RoutineService(db, f.host, {
        listRoutineFolderIds: id => f.store.listRoutineFolderIds(id),
        writeRoutine: async (botId, id, tx) => { await f.store.writeRoutine(botId, id, tx); throw new Error("injected rollback after disk write"); },
        deleteRoutine: async () => {},
      });
      await assert.rejects(() => fault.mutate(f.botId, callId, null, input), /injected rollback/);
      assert.equal(await db.routine.count({ where: { botId: f.botId, name: input.name } }), 0);
      await f.sync();
      assert.equal(await db.routine.count({ where: { botId: f.botId, name: input.name, enabled: true } }), 1);
      await f.service.mutate(f.botId, callId, null, input);
      assert.equal(await db.routine.count({ where: { botId: f.botId, name: input.name, enabled: true } }), 2);
    } finally { await f.cleanup(); }
  });

  await check("delete rollback removes the file; later sync deletes the routine despite the DB rollback", async () => {
    const f = await fixture();
    try {
      const fault = new RoutineService(db, f.host, {
        writeRoutine: (botId, id, tx) => f.store.writeRoutine(botId, id, tx),
        deleteRoutine: async (botId, id, tx) => { await f.store.deleteRoutine(botId, id, tx); throw new Error("injected rollback after disk delete"); },
      });
      await assert.rejects(() => fault.mutate(f.botId, randomUUID(), null, { action: "delete", id: f.routine.id }), /injected rollback/);
      assert.equal((await f.read()).deletedAt, null);
      await f.sync();
      assert((await f.read()).deletedAt);
      assert.equal((await f.read()).enabled, false);
    } finally { await f.cleanup(); }
  });

  await check("control: overlapping executions record one skip and preserve its lastRunAt through sync", async () => {
    const f = await fixture({ type: "group", listeners: [cron("0 12 * * *"), cron("0 13 * * *")] });
    try {
      assert.equal(await f.service.dispatchDue(now), 1);
      // The first run is still queued. Dispatch the second listener without a
      // file sync so its legitimate overlap skip is recorded at 13:00.
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:00:00Z")), 0);
      assert.equal(iso((await f.read()).lastRunAt), "2026-11-12T13:00:00.000Z");
      await f.sync();
      assert.equal(iso((await f.read()).lastRunAt), "2026-11-12T13:00:00.000Z");
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-13T12:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("50 backlogged routines monopolize every dispatch page and create overlap skips while a healthy bot starves", async () => {
    const old = new Date("2025-11-12T00:00:00Z");
    const backlog = await fixture(cron("0 9 * * *"), old);
    const healthy = await fixture(cron("0 12 * * *"));
    try {
      for (let n = 1; n < 50; n++) await writeAutomationFiles(backlog.botDirectory, { ...definition(cron("0 9 * * *"), old), slug: `backlog-${String(n).padStart(2, "0")}` });
      await backlog.sync();
      assert.equal(await db.routine.count({ where: { botId: backlog.botId } }), 50);
      for (let n = 0; n < 3; n++) {
        await backlog.sync();
        assert.equal(await backlog.service.dispatchDue(now), n === 0 ? 50 : 0);
      }
      assert.equal(await db.routineExecution.count({ where: { routine: { botId: backlog.botId }, status: "skipped", skipReason: "overlap" } }), 100);
      assert.equal(await db.routineExecution.count({ where: { routineId: healthy.routine.id } }), 0);
    } finally { await backlog.cleanup(); await healthy.cleanup(); }
  });

  await check("file import bypasses the 50-routines-per-owner API limit", async () => {
    const f = await fixture();
    try {
      for (let n = 1; n < 51; n++) await writeAutomationFiles(f.botDirectory, { ...definition(), slug: `extra-${n}` });
      assert.deepEqual((await f.sync()).warnings, []);
      assert.equal(await db.routine.count({ where: { botId: f.botId, deletedAt: null } }), 51);
      await assert.rejects(() => f.service.mutate(f.botId, randomUUID(), null, { action: "create", name: "API refuses", prompt: "Run", schedule: "@daily" }), /at most 50/);
    } finally { await f.cleanup(); }
  });

  await check("control: eight concurrent schedulers dispatch one occurrence exactly once", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => f.service.dispatchDue(now)));
      assert.equal(results.reduce((sum, n) => sum + n, 0), 1);
      assert.equal(await db.routineExecution.count({ where: { routineId: f.routine.id } }), 1);
    } finally { await f.cleanup(); }
  });

  await check("100 live executions starve recovery of a completed execution on another routine", async () => {
    const fixtures = [await fixture(), await fixture(), await fixture()];
    try {
      // Stay within the supported 50 routines per owner: 50 + 50 + 1.
      for (const f of fixtures.slice(0, 2)) {
        for (let n = 1; n < 50; n++) await writeAutomationFiles(f.botDirectory, { ...definition(), slug: `recovery-${n}` });
      }
      await fixtures[0]!.sync();
      for (const f of fixtures) {
        const rows = await db.routine.findMany({ where: { botId: f.botId } });
        for (const row of rows) await f.service.runNow(f.botId, row.id, randomUUID(), now);
      }
      const all = await db.routineExecution.findMany({ select: { id: true, runId: true } });
      assert.equal(all.length, 101);
      const page = await db.routineExecution.findMany({
        where: { status: { in: ["queued", "running"] } },
        take: 100, select: { id: true, runId: true },
      });
      const inPage = new Set(page.map(e => e.id));
      const victim = all.find(e => !inPage.has(e.id))!;
      await db.run.update({ where: { id: victim.runId! }, data: { status: "completed", completedAt: now } });
      const { WakeWorker } = await import("../apps/worker/src/worker");
      // Run the real recovery method without starting queues or a computer.
      const worker: any = Object.assign(Object.create(WakeWorker.prototype), {
        prisma: db, routines: fixtures[0]!.service, agentData: fixtures[0]!.store,
      });
      for (let n = 0; n < 3; n++) await worker.recoverRoutineExecutions();
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: victim.id } })).status, "queued");
      // Free one recovery-page slot. The otherwise identical victim settles.
      await db.run.update({ where: { id: page[0]!.runId! }, data: { status: "completed", completedAt: now } });
      await worker.recoverRoutineExecutions();
      await worker.recoverRoutineExecutions();
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: victim.id } })).status, "completed");
    } finally { for (const f of fixtures) await f.cleanup(); }
  });

  await check("year-old five-minute interval exceeds dispatch transaction timeout instead of catching up in constant time", async () => {
    const f = await fixture(cron("@every 5m"), new Date("2025-11-12T12:00:00Z"));
    try {
      const started = performance.now();
      assert.equal(await f.service.dispatchDue(now), 0);
      const elapsed = performance.now() - started;
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: f.routine.id } });
      assert.equal(execution.status, "failed");
      assert(elapsed > 5000, `Expected transaction timeout, measured ${elapsed}ms`);
      console.log(JSON.stringify({ intervalDowntimeMs: Math.round(elapsed), error: execution.error }));
    } finally { await f.cleanup(); }
  });

  console.log(JSON.stringify({ checks: outcomes.length, outcomes }));
  assert(outcomes.every(o => o.result === "confirmed"));
} finally {
  setSystemTime();
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
