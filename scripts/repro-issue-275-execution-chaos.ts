// Execution/event fault characterization on unmodified production code.
// An EMPTY disposable PostgreSQL database with the current Prisma schema is required.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/repro-issue-275-execution-chaos.ts [name-filter]
// Only queue delivery/computer execution are stubbed. Messaging, claiming,
// scheduling, result reconciliation, shell callback routing and SQL are real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPrismaClient } from "../packages/db/src/index";
import { AgentDataStore, AgentMessaging, RoutineService } from "../packages/messaging/src/index";
import { reconcileRoutineExecution, wakeAutomationParent } from "../packages/messaging/src/automation-results";
import { stopRequestProgress } from "../packages/messaging/src/request-progress";
import { RunService } from "../apps/server/src/services/run-service";
import { WakeWorker } from "../apps/worker/src/worker";

const { Effect } = createRequire(new URL("../packages/db/package.json", import.meta.url))("effect");

assert(process.env.OPENTEAM_TEST_DATABASE_URL);
const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
assert.equal(await db.bot.count(), 0, "Use an empty disposable database");
const root = await mkdtemp(join(tmpdir(), "openteam-275-execution-chaos-"));
const outcomes: Array<{ name: string; result: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { await fn(); outcomes.push({ name, result: "confirmed" }); console.log(`CONFIRMED: ${name}`); }
  catch (error) { outcomes.push({ name, result: "FAILED" }); console.error(name, error); }
}
async function fixture(trigger: Record<string, unknown> = { type: "cron", schedule: "@every 5m" }, enabled = false) {
  const botId = randomUUID(), channelId = randomUUID(), conversationId = randomUUID();
  const groupIds: string[] = [];
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  const messaging = new AgentMessaging(db, { send: async () => "job", sendDebounced: async () => "job" } as never, store);
  messaging.isTimelineSessionActive = async () => false;
  const service = new RoutineService(db, messaging, store);
  messaging.onGroupRoutineSettled = settled => service.afterGroupExecution(settled);
  const worker: any = Object.assign(Object.create(WakeWorker.prototype), { prisma: db, messaging, routines: service, agentData: store, workspaceRoot: root });
  await db.bot.create({ data: { id: botId, name: "Execution chaos", status: "active", defaultDirectory: root, conversation: { create: { id: conversationId } } } });
  await db.channel.create({ data: { id: channelId, name: "Execution chaos", kind: "bot_dm", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
  const created = await service.mutate(botId, randomUUID(), null, { action: "create", name: "Execution chaos", prompt: "Execute the saved task", trigger, enabled });
  const routineId = String(created.id);
  const routine = () => db.routine.findUniqueOrThrow({ where: { id: routineId } });
  const execute = async () => {
    const execution = await service.runNow(botId, routineId, randomUUID());
    return db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } });
  };
  const terminal = async (runId: string, status: "completed" | "failed" | "cancelled" = "completed") => {
    await db.run.update({ where: { id: runId }, data: { status, completedAt: new Date() } });
    await db.inboxEvent.updateMany({ where: { runId }, data: { status: "completed", completedAt: new Date() } });
    await db.botRunLease.deleteMany({ where: { runId } });
  };
  const context = (runId: string) => ({ botId, conversationId, channelId, runId, callId: randomUUID(), origin: "routine" as const, isFork: false, deliveryId: null, replyToMessageId: null });
  const makeGroup = async () => {
    const id = randomUUID(); groupIds.push(id);
    await db.channel.create({ data: { id, name: "Execution chaos group", kind: "group", members: { create: { botId, ordinal: 0 } } } });
    const result = await service.mutateOwner({ kind: "group", id }, randomUUID(), null, { action: "create", name: "Group execution chaos", prompt: "Execute the saved task", schedule: "@every 5m", enabled: true });
    return { channelId: id, routineId: String(result.id) };
  };
  const cleanup = async () => {
    const routines = await db.routine.findMany({ where: { OR: [{ botId }, { channelId: { in: groupIds } }] }, select: { id: true } });
    const ids = routines.map(r => r.id);
    const execs = await db.routineExecution.findMany({ where: { routineId: { in: ids } }, select: { id: true } });
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...execs.map(e => e.id)] } } });
    await db.channel.deleteMany({ where: { id: { in: [channelId, ...groupIds] } } });
    await db.bot.delete({ where: { id: botId } });
    await rm(store.botDirectory(botId), { recursive: true, force: true });
  };
  return { botId, channelId, conversationId, store, messaging, service, worker, routineId, routine, execute, terminal, context, makeGroup, cleanup };
}

try {
  await db.userTimeZoneSettings.upsert({ where: { id: "global" }, create: { id: "global", detected: "UTC" }, update: { detected: "UTC", override: null } });

  await check("one unavailable event listener blocks delivery to a healthy bot on every retry", async () => {
    const fixtures = [await fixture({ type: "email", inbox: "team@example.com" }, true), await fixture({ type: "email", inbox: "team@example.com" }, true)];
    try {
      const order = await db.routine.findMany({ where: { enabled: true, deletedAt: null } });
      const bad = fixtures.find(f => f.routineId === order[0]!.id)!;
      const good = fixtures.find(f => f !== bad)!;
      await db.channel.update({ where: { id: bad.channelId }, data: { archivedAt: new Date() } });
      const event = { id: randomUUID(), source: "email", kind: "received", text: "Subject: Test event", channel: "team@example.com", actor: "sender@example.com", authenticatedUser: true };
      for (let n = 0; n < 3; n++) await assert.rejects(() => good.service.dispatchEventToAll(event), (e: any) => e.code === "routine_channel_unavailable");
      assert.equal(await db.routineExecution.count({ where: { routineId: good.routineId } }), 0);
      await db.channel.update({ where: { id: bad.channelId }, data: { archivedAt: null } });
      assert.equal((await good.service.dispatchEventToAll(event)).length, 2);
    } finally { for (const f of fixtures) await f.cleanup(); }
  });

  await check("a group dispatch handoff failure leaves a queued round stuck until startup-style round recovery", async () => {
    const f = await fixture();
    try {
      const group = await f.makeGroup();
      const row = await db.routine.findUniqueOrThrow({ where: { id: group.routineId } });
      const fault = new RoutineService(db, {
        enqueueWake: f.messaging.enqueueWake.bind(f.messaging),
        createGroupRound: f.messaging.createGroupRound.bind(f.messaging) as never,
        advanceRound: async () => { throw new Error("injected group handoff failure"); },
      }, f.store);
      await assert.rejects(() => fault.dispatchDue(row.nextRunAt!), /injected group handoff/);
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: group.routineId } });
      const round = await db.channelRound.findFirstOrThrow({ where: { rootMessageId: execution.channelMessageId! } });
      for (let n = 0; n < 3; n++) await f.worker.recoverRoutineExecutions();
      assert.equal((await db.channelRound.findUniqueOrThrow({ where: { id: round.id } })).status, "queued");
      assert.equal(await db.run.count({ where: { channelId: group.channelId } }), 0);
      const next = (await db.routine.findUniqueOrThrow({ where: { id: group.routineId } })).nextRunAt!;
      assert.equal(await f.service.dispatchDue(next), 0);
      assert.equal(await db.routineExecution.count({ where: { routineId: group.routineId, status: "skipped", skipReason: "overlap" } }), 1);
      await f.messaging.recoverRounds();
      assert.equal((await db.channelRound.findUniqueOrThrow({ where: { id: round.id } })).status, "running");
      assert.equal(await db.run.count({ where: { channelId: group.channelId } }), 1);
    } finally { await f.cleanup(); }
  });

  await check("a late shell callback resumes an explicitly stopped and cancelled automation", async () => {
    const f = await fixture();
    try {
      const execution = await f.execute();
      const runId = execution.runId!;
      assert.equal((await f.worker.claim(f.botId))?.runId, runId);
      await db.runItem.create({ data: { runId, kind: "command", status: "completed", content: { shellKind: "background", result: { details: { status: "running", outputPath: "/tmp/stopped-shell.log" } } } } });
      await db.$transaction(tx => stopRequestProgress(tx, f.botId, runId));
      await Effect.runPromise(new RunService(db, async () => new Response("", { status: 200 })).cancel(runId));
      assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, "cancelled");
      assert((await db.run.findUniqueOrThrow({ where: { id: runId } })).requestStoppedAt);
      const response = await f.messaging.completeShell({ id: randomUUID(), scope: f.botId, channelId: f.channelId, automationRunId: runId, outputPath: "/tmp/stopped-shell.log", exitCode: 0, title: "Late result" });
      assert.equal(response.delivered, true);
      const claimed = await f.worker.claim(f.botId);
      assert(claimed);
      assert.equal(claimed.origin, "routine");
      assert.notEqual(claimed.runId, runId);
      const notification = await wakeAutomationParent(f.messaging, f.context(claimed.runId), { message: "Late notification after Stop" });
      assert.equal(notification.woken, true);
      assert.equal((await db.run.findUniqueOrThrow({ where: { id: notification.run_id } })).origin, "background_revival");
    } finally { await f.cleanup(); }
  });

  await check("a callback queued before WakeParent remains claimable after the automation handed off", async () => {
    const f = await fixture();
    try {
      const execution = await f.execute();
      const rootId = execution.runId!;
      await db.run.update({ where: { id: rootId }, data: { status: "running" } });
      await db.inboxEvent.updateMany({ where: { runId: rootId }, data: { status: "completed" } });
      await f.messaging.completeShell({ id: randomUUID(), scope: f.botId, channelId: f.channelId, automationRunId: rootId, outputPath: "/tmp/queued-before-handoff.log", exitCode: 0, title: "Result" });
      const handoff = await wakeAutomationParent(f.messaging, f.context(rootId), { message: "Task complete" });
      await f.terminal(rootId);
      const parent = await f.worker.claim(f.botId);
      assert.equal(parent?.runId, handoff.run_id);
      const obsolete = await f.worker.claim(f.botId);
      assert(obsolete);
      assert.equal(obsolete.origin, "routine");
      // A callback arriving later is correctly ignored; only the queued one leaks.
      const late = await f.messaging.completeShell({ id: randomUUID(), scope: f.botId, channelId: f.channelId, automationRunId: rootId, outputPath: "/tmp/after-handoff.log", exitCode: 0, title: "Later result" });
      assert.equal(late.delivered, false);
    } finally { await f.cleanup(); }
  });

  await check("a callback with an unknown automation run ID is routed into the user-facing foreground", async () => {
    const f = await fixture();
    try {
      const result = await f.messaging.completeShell({ id: randomUUID(), scope: f.botId, channelId: f.channelId, automationRunId: randomUUID(), outputPath: "/tmp/orphaned-shell.log", exitCode: 0, title: "Orphaned automation result" });
      assert.equal(result.delivered, true);
      const claimed = await f.worker.claim(f.botId);
      assert(claimed);
      assert.equal(claimed.origin, "background_revival");
    } finally { await f.cleanup(); }
  });

  await check("a failed batched continuation is marked successful because a folded newer run was marked completed", async () => {
    const f = await fixture();
    try {
      const execution = await f.execute();
      const rootId = execution.runId!;
      await f.terminal(rootId);
      for (let n = 0; n < 2; n++) {
        const id = `batched-${n}-${randomUUID()}`;
        await f.messaging.completeShell({ id, scope: f.botId, channelId: f.channelId, automationRunId: rootId, outputPath: `/tmp/${id}.log`, exitCode: 0, title: `Result ${n}` });
      }
      const pending = await db.inboxEvent.findMany({ where: { botId: f.botId, status: "pending" }, orderBy: { createdAt: "asc" }, include: { run: true } });
      assert.equal(pending.length, 2);
      const first = new Date(Date.now() - 2000), second = new Date(Date.now() - 1000);
      for (const [n, time] of [first, second].entries()) {
        await db.inboxEvent.update({ where: { id: pending[n]!.id }, data: { createdAt: time } });
        await db.run.update({ where: { id: pending[n]!.runId }, data: { createdAt: time } });
      }
      await db.run.update({ where: { id: rootId }, data: { createdAt: new Date(Date.now() - 3000) } });
      const claimed = await f.worker.claim(f.botId);
      assert.equal(claimed?.runId, pending[0]!.runId);
      assert.equal((await db.run.findUniqueOrThrow({ where: { id: pending[1]!.runId } })).status, "completed");
      await f.terminal(claimed!.runId, "failed");
      await db.$transaction(tx => reconcileRoutineExecution(tx, claimed!.runId));
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } })).status, "completed");
    } finally { await f.cleanup(); }
  });

  await check("an invalid Teams regex is accepted as enabled and silently never matches", async () => {
    const trigger = { type: "microsoftTeams", tenantId: "tenant", teamIds: ["team"], messageContains: "[", messageContainsIsRegex: true };
    const f = await fixture(trigger, true);
    try {
      assert.equal((await f.routine()).enabled, true);
      const event = { id: randomUUID(), source: "microsoftTeams", kind: "message", text: "Deployment ready", tenantId: "tenant", teamId: "team", authenticatedUser: true };
      assert.equal((await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event)).length, 0);
      assert.equal(await db.routineExecution.count({ where: { routineId: f.routineId } }), 0);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, trigger: { ...trigger, messageContains: "Deployment" } });
      assert.equal((await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { ...event, id: randomUUID() })).length, 1);
    } finally { await f.cleanup(); }
  });

  await check("one failed follow-up launch rolls back root settlement and blocks recovery for another bot", async () => {
    const fixtures = [await fixture({ type: "webhook" }, true), await fixture({ type: "webhook" }, true)];
    try {
      const event = () => ({ id: randomUUID(), source: "webhook", kind: "received", text: "Event" });
      for (const f of fixtures) {
        await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event());
        const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: f.routineId } });
        await f.terminal(execution.runId!);
      }
      // The production recovery query has no ordering. Target the first
      // execution it actually selects; do not assume insertion order.
      const page = await db.routineExecution.findMany({
        where: {
          status: { in: ["queued", "running"] },
          OR: [{ runId: { not: null } }, { channelMessageId: { not: null } }],
          routine: { OR: [{ bot: { status: "active" } }, { channel: { kind: "group", archivedAt: null } }] },
        },
        select: { id: true, runId: true, channelMessageId: true, routine: { select: { botId: true, channelId: true } }, run: { select: { status: true, completedAt: true, error: true } } },
        take: 100,
      });
      const bad = fixtures.find(f => f.botId === page[0]!.routine.botId)!;
      const good = fixtures.find(f => f !== bad)!;
      const badRoot = await db.routineExecution.findFirstOrThrow({ where: { routineId: bad.routineId } });
      const goodRoot = await db.routineExecution.findFirstOrThrow({ where: { routineId: good.routineId } });
      // Another event arrives after the model finished but before its routine
      // execution was settled. It queues a follow-up through the real service.
      await bad.service.dispatchEvent({ kind: "bot", id: bad.botId }, event());
      const followUp = await db.routineExecution.findFirstOrThrow({ where: { routineId: bad.routineId, runId: null } });
      assert.equal(followUp.status, "queued");
      good.worker.routines = new RoutineService(db, {
        enqueueWake: async (tx, input) => {
          if (input.botId === bad.botId) throw new Error("injected follow-up launch failure");
          return good.messaging.enqueueWake(tx, input);
        },
      }, good.store);
      for (let n = 0; n < 3; n++) await assert.rejects(() => good.worker.recoverRoutineExecutions(), /follow-up launch failure/);
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: badRoot.id } })).status, "queued");
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: goodRoot.id } })).status, "queued");
      good.worker.routines = good.service;
      await good.worker.recoverRoutineExecutions();
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: goodRoot.id } })).status, "completed");
    } finally { for (const f of fixtures) await f.cleanup(); }
  });

  await check("file imports bypass the API refusal of unscoped high-volume GitHub listeners", async () => {
    const f = await fixture({ type: "github", repo: "org/repo", events: ["pr-opened"] }, true);
    try {
      const unscoped = { type: "github", repo: "org/repo", events: ["pr-pushed"] };
      await assert.rejects(() => f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, trigger: unscoped }), /not scoped/);
      const routine = await f.routine();
      const path = join(f.store.botDirectory(f.botId), "automations", routine.slug, "automation.json");
      const json = JSON.parse(await readFile(path, "utf8"));
      json.trigger = unscoped;
      await writeFile(path, JSON.stringify(json));
      assert.deepEqual((await f.store.reconcileAutomationFilesBatch(null, 100)).warnings, []);
      assert.deepEqual((await f.routine()).trigger, unscoped);
      const result = await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { id: randomUUID(), source: "github", kind: "pr-pushed", text: "Unscoped push", repo: "org/repo", pr: 123, actor: "anyone", prOwner: "anyone" });
      assert.equal(result.length, 1);
    } finally { await f.cleanup(); }
  });

  console.log(JSON.stringify({ checks: outcomes.length, outcomes }));
  assert(outcomes.length > 0, "No matching checks");
  assert(outcomes.every(o => o.result === "confirmed"));
} finally {
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
