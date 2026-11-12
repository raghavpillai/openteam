// Investigation/characterization checks, not regression tests: these assertions
// document current broken behavior. Production code is unmodified.
// Requires an EMPTY disposable database with the current Prisma schema applied:
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/repro-issue-275-extent.ts
import assert from "node:assert/strict";
import { setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../packages/db/src/index";
import { AgentDataStore } from "../packages/messaging/src/agent-data";
import { parseAutomationFile, writeAutomationFiles } from "../packages/messaging/src/automation-files";
import { followUserTimeZone, nextRoutineRun, nextRoutineTriggerRun, normalizeRoutineMutationTrigger, RoutineService } from "../packages/messaging/src/routines";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
assert(url, "Set OPENTEAM_TEST_DATABASE_URL to an empty disposable test database");
const db = createPrismaClient(url);
assert.equal(await db.bot.count(), 0, "Use an empty disposable database");
const root = await mkdtemp(join(tmpdir(), "openteam-275-extent-files-"));
const base = new Date("2026-11-10T00:00:00Z");
const cron = (schedule: string) => ({ type: "cron", schedule });
const group = (...listeners: Record<string, unknown>[]) => ({ type: "group", listeners });
const iso = (value: Date | null) => value?.toISOString() ?? null;
let checks = 0;
const failures: string[] = [];
const outcomes: Array<{ name: string; result: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  try { await fn(); checks++; outcomes.push({ name, result: "confirmed" }); console.log(`CONFIRMED: ${name}`); }
  catch (error) { failures.push(name); outcomes.push({ name, result: "FAILED" }); console.error(name, error); }
  finally { setSystemTime(); }
}

const definition = (trigger: Record<string, unknown>, options: { createdAt?: Date; lastRunAt?: Date | null; enabled?: boolean } = {}) => ({
  name: "Extent fixture", prompt: "Record this scheduled occurrence.", trigger,
  triggerPresentation: null,
  scheduleText: trigger.type === "cron" ? String(trigger.schedule) : "unused group summary",
  enabled: options.enabled ?? true, provenance: "user", createdAt: options.createdAt ?? base,
  lastRunAt: options.lastRunAt ?? null, pendingNotices: [], raisedNotices: [],
});

async function parse(trigger: Record<string, unknown>, options: Parameters<typeof definition>[1] = {}) {
  const directory = join(root, randomUUID());
  const written = await writeAutomationFiles(directory, definition(trigger, options));
  const path = join(written.directory, "automation.json");
  return parseAutomationFile(path, await readFile(path, "utf8"), "UTC");
}

async function fixture(trigger: Record<string, unknown>, options: Parameters<typeof definition>[1] = {}) {
  const botId = randomUUID(), conversationId = randomUUID(), channelId = randomUUID(), groupId = randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  await db.bot.create({ data: { id: botId, name: "Extent", status: "active", defaultDirectory: root, conversation: { create: { id: conversationId } } } });
  await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Extent", directKey: `bot:${botId}` } });
  const host = {
    isTimelineSessionActive: async () => false,
    enqueueWake: async (tx: any) => ({ run: await tx.run.create({ data: { botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine" } }) }),
    createGroupRound: async (tx: any, input: any) => tx.channelRound.create({ data: { channelId: input.channelId, triggerMessageId: input.triggerMessageId, rootMessageId: input.triggerMessageId } }),
    advanceRound: async () => {},
  };
  const service = new RoutineService(db, host, store);
  await writeAutomationFiles(store.botDirectory(botId), { ...definition(trigger, options), slug: "extent" });
  const sync = async () => {
    const result = await store.reconcileAutomationFilesBatch(null, 100);
    assert.deepEqual(result.warnings, []);
  };
  await sync();
  const read = () => db.routine.findUniqueOrThrow({ where: { botId_slug: { botId, slug: "extent" } } });
  const routine = await read();
  const complete = async () => {
    await db.routineExecution.updateMany({ where: { routineId: routine.id }, data: { status: "completed" } });
    await db.run.updateMany({ where: { botId }, data: { status: "completed" } });
  };
  const cleanup = async () => {
    const routines = await db.routine.findMany({ where: { OR: [{ botId }, { channelId: groupId }] }, select: { id: true } });
    const ids = routines.map(r => r.id);
    const executions = await db.routineExecution.findMany({ where: { routineId: { in: ids } }, select: { id: true } });
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...executions.map(e => e.id)] } } });
    await db.bot.delete({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: { in: [channelId, groupId] } } });
  };
  return { botId, groupId, store, service, sync, read, routine, complete, cleanup };
}

try {
  await db.userTimeZoneSettings.upsert({ where: { id: "global" }, create: { id: "global", detected: "UTC" }, update: { detected: "UTC", override: null } });

  for (const [name, trigger, expected, actual] of [
    ["daily schedules", group(cron("0 18 * * *"), cron("0 3 * * *")), "2026-11-10T03:00:00.000Z", "2026-11-10T18:00:00.000Z"],
    ["weekly plus daily", group(cron("0 9 * * 1"), cron("0 9 * * *")), "2026-11-10T09:00:00.000Z", "2026-11-16T09:00:00.000Z"],
    ["pinned schedules in different zones", group(cron("CRON_TZ=America/New_York 0 18 * * *"), cron("CRON_TZ=Asia/Tokyo 0 18 * * *")), "2026-11-10T09:00:00.000Z", "2026-11-10T23:00:00.000Z"],
    ["long interval before short interval", group(cron("@every 1h"), cron("@every 5m")), "2026-11-10T00:05:00.000Z", "2026-11-10T01:00:00.000Z"],
    ["calendar before interval", group(cron("0 18 * * *"), cron("@every 5m")), "2026-11-10T00:05:00.000Z", "2026-11-10T18:00:00.000Z"],
    ["phased intervals", group(cron("@every 1h/30m"), cron("@every 1h/5m")), "2026-11-10T00:05:00.000Z", "2026-11-10T00:30:00.000Z"],
    ["eight schedules", group(...[18, 17, 16, 15, 14, 13, 12, 3].map(h => cron(`0 ${h} * * *`))), "2026-11-10T03:00:00.000Z", "2026-11-10T18:00:00.000Z"],
  ] as const) {
    await check(name, async () => {
      const parsed = await parse(trigger);
      assert(parsed.schedule);
      const all = nextRoutineTriggerRun(parsed.trigger, parsed.schedule, base, "UTC");
      assert.equal(iso(all), expected);
      assert.equal(iso(parsed.nextRunAt), actual);
    });
  }

  await check("non-time listener preceding the only time listener still schedules correctly", async () => {
    assert.equal(iso((await parse(group({ type: "webhook" }, cron("0 3 * * *")))).nextRunAt), "2026-11-10T03:00:00.000Z");
    assert.equal((await parse(group({ type: "webhook" }, { type: "email", inbox: "a@example.com" }))).nextRunAt, null);
  });
  await check("one cron expression with multiple hours is unaffected", async () => {
    assert.equal(iso((await parse(cron("0 3,18 * * *"))).nextRunAt), "2026-11-10T03:00:00.000Z");
    assert.equal((await parse(group(cron("0 3 * * *"), cron("0 18 * * *")), { enabled: false })).nextRunAt, null);
  });

  await check("later invalid and too-frequent schedules pass file validation but fail API validation", async () => {
    for (const late of ["not-a-cron", "*/1 * * * *"]) {
      const trigger = group(cron("@every 5m"), cron(late));
      assert((await parse(trigger)).nextRunAt);
      assert.throws(() => normalizeRoutineMutationTrigger({ trigger }, "UTC"));
    }
  });

  await check("API-created bot routine starts correct, then unchanged file sync corrupts nextRunAt", async () => {
    const f = await fixture(cron("@every 5m"));
    try {
      const trigger = group(cron("0 18 * * *"), cron("0 13 * * *"));
      const result = await f.service.mutate(f.botId, randomUUID(), null, { action: "create", name: "API routine", prompt: "Run", trigger, source: "ui" });
      const id = String(result.id);
      assert.equal(iso((await db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt), "2026-11-12T13:00:00.000Z");
      await f.sync();
      assert.equal(iso((await db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt), "2026-11-12T18:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("pause stays paused; resume of a single schedule is rewound to the paused period", async () => {
    const f = await fixture(cron("0 9 * * *"), { enabled: false });
    try {
      assert.equal((await f.read()).nextRunAt, null);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "resume", id: f.routine.id });
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-13T09:00:00.000Z");
      await f.sync();
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-10T09:00:00.000Z");
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T12:00:00Z")), 1);
    } finally { await f.cleanup(); }
  });

  await check("editing a single schedule is rewound to before the edit", async () => {
    const f = await fixture(cron("0 9 * * *"));
    try {
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routine.id, schedule: "0 10 * * *" });
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-13T10:00:00.000Z");
      await f.sync();
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-10T10:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  for (const [label, schedule, nextAfterSync] of [
    ["cron", "0 9 * * *", "2026-11-11T09:00:00.000Z"],
    ["interval", "@every 1h", "2026-11-10T02:00:00.000Z"],
  ]) {
    await check(`downtime catch-up is undone for single ${label}; historical occurrences run again on later passes`, async () => {
      const f = await fixture(cron(schedule!));
      try {
        const now = new Date("2026-11-12T12:00:00Z");
        assert.equal(await f.service.dispatchDue(now), 1);
        assert((await f.read()).nextRunAt! > now);
        await f.complete();
        await f.sync();
        assert.equal(iso((await f.read()).nextRunAt), nextAfterSync!);
        assert.equal(await f.service.dispatchDue(now), 1);
        assert.equal(await db.routineExecution.count({ where: { routineId: f.routine.id } }), 2);
      } finally { await f.cleanup(); }
    });
  }

  await check("manual run shifts a single relative interval only after file sync", async () => {
    const f = await fixture(cron("@every 1h"));
    try {
      const before = iso((await f.read()).nextRunAt);
      await f.service.runNow(f.botId, f.routine.id, randomUUID(), new Date("2026-11-10T00:30:00Z"));
      assert.equal(iso((await f.read()).nextRunAt), before);
      await f.sync();
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-10T01:30:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("event delivery shifts a mixed routine's relative interval only after file sync", async () => {
    const f = await fixture(group({ type: "webhook" }, cron("@every 1h")));
    try {
      const before = iso((await f.read()).nextRunAt);
      setSystemTime(new Date("2026-11-10T00:30:00Z"));
      assert.equal((await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { id: randomUUID(), source: "webhook", kind: "received", text: "Test" })).length, 1);
      assert.equal(iso((await f.read()).nextRunAt), before);
      await f.sync();
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-10T01:30:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("timezone updates of a single unpinned cron are rewound by file sync", async () => {
    const f = await fixture(cron("0 9 * * *"));
    try {
      await db.routine.update({ where: { id: f.routine.id }, data: { nextRunAt: new Date("2026-11-13T09:00:00Z") } });
      await db.$transaction(async tx => {
        await tx.userTimeZoneSettings.update({ where: { id: "global" }, data: { override: "America/New_York" } });
        await followUserTimeZone(tx, "America/New_York", new Date("2026-11-12T12:00:00Z"));
      });
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-12T14:00:00.000Z");
      await f.sync();
      assert.equal(iso((await f.read()).nextRunAt), "2026-11-10T14:00:00.000Z");
    } finally {
      await db.userTimeZoneSettings.update({ where: { id: "global" }, data: { override: null } });
      await f.cleanup();
    }
  });

  await check("invalid later file schedule aborts dispatch before a healthy unrelated routine", async () => {
    const broken = await fixture(group(cron("@every 5m"), cron("not-a-cron")));
    const healthy = await fixture(cron("@every 5m"), { createdAt: new Date("2026-11-10T00:01:00Z") });
    try {
      await assert.rejects(() => broken.service.dispatchDue(new Date("2026-11-10T00:07:00Z")));
      assert.equal(await db.routineExecution.count(), 0);
      assert.equal(iso((await healthy.read()).nextRunAt), "2026-11-10T00:06:00.000Z");
      assert.equal(iso((await broken.read()).nextRunAt), "2026-11-10T00:05:00.000Z");
    } finally { await broken.cleanup(); await healthy.cleanup(); }
  });

  await check("group-owned multi-cron routine survives bot file sync and dispatches the second listener", async () => {
    const f = await fixture(cron("@every 5m"), { enabled: false });
    try {
      await db.channel.create({ data: { id: f.groupId, name: "Extent group", kind: "group", members: { create: { botId: f.botId, ordinal: 0 } } } });
      const created = await f.service.mutateOwner({ kind: "group", id: f.groupId }, randomUUID(), null, { action: "create", name: "Group routine", prompt: "Run", trigger: group(cron("0 18 * * *"), cron("0 13 * * *")) });
      const id = String(created.id);
      await f.sync();
      assert.equal(iso((await db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt), "2026-11-12T13:00:00.000Z");
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:00:00Z")), 1);
      assert.equal(iso((await db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt), "2026-11-12T18:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("separate grouped-schedule validation gap: two valid listeners can fire less than five minutes apart", async () => {
    const f = await fixture(cron("@every 5m"), { enabled: false });
    try {
      await db.channel.create({ data: { id: f.groupId, name: "Extent group", kind: "group", members: { create: { botId: f.botId, ordinal: 0 } } } });
      const created = await f.service.mutateOwner({ kind: "group", id: f.groupId }, randomUUID(), null, {
        action: "create", name: "Close listeners", prompt: "Run",
        trigger: group(cron("0 13 * * *"), cron("2 13 * * *")),
      });
      const id = String(created.id);
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:00:00Z")), 1);
      await db.routineExecution.updateMany({ where: { routineId: id }, data: { status: "completed" } });
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:02:00Z")), 1);
      assert.equal(await db.routineExecution.count({ where: { routineId: id } }), 2);
    } finally { await f.cleanup(); }
  });

  await check("a helper-only file-sync fix must pass the installation zone explicitly", async () => {
    const parsed = await parse(group(cron("CRON_TZ=Asia/Tokyo 0 18 * * *"), cron("0 8 * * *")));
    assert(parsed.schedule);
    assert.equal(iso(nextRoutineTriggerRun(parsed.trigger, parsed.schedule, base, "UTC")), "2026-11-10T08:00:00.000Z");
    assert.equal(iso(nextRoutineTriggerRun(parsed.trigger, parsed.schedule, base)), "2026-11-10T09:00:00.000Z");
  });

  await check("separate helper limitation: relative grouped intervals lose the longer interval's cadence, including group owners", async () => {
    const { trigger, schedule } = normalizeRoutineMutationTrigger({ trigger: group(cron("@every 10m"), cron("@every 15m")) }, "UTC");
    const first = nextRoutineTriggerRun(trigger, schedule, base, "UTC");
    assert.equal(iso(first), "2026-11-10T00:10:00.000Z");
    assert.equal(iso(nextRoutineRun(normalizeRoutineMutationTrigger({ schedule: "@every 15m" }, "UTC").schedule, base)), "2026-11-10T00:15:00.000Z");
    assert.equal(iso(nextRoutineTriggerRun(trigger, schedule, first, "UTC")), "2026-11-10T00:20:00.000Z");
    const f = await fixture(cron("@every 5m"), { enabled: false });
    try {
      await db.channel.create({ data: { id: f.groupId, name: "Extent group", kind: "group", members: { create: { botId: f.botId, ordinal: 0 } } } });
      const created = await f.service.mutateOwner({ kind: "group", id: f.groupId }, randomUUID(), null, { action: "create", name: "Interval union", prompt: "Run", trigger });
      const id = String(created.id);
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T12:10:00Z")), 1);
      await db.routineExecution.updateMany({ where: { routineId: id }, data: { status: "completed" } });
      assert.equal(iso((await db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt), "2026-11-12T12:20:00.000Z");
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T12:15:00Z")), 0);
    } finally { await f.cleanup(); }
  });

  console.log(JSON.stringify({ confirmedChecks: checks, failures, outcomes }));
  assert.equal(failures.length, 0);
} finally {
  setSystemTime();
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
