import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient, Prisma } from "@openteam/db";
import { RoutineService } from "../src/routines";
import { triggerIdentity } from "../src/automation-trigger";
import { repairRoutineScheduling } from "../../../scripts/repair-routine-scheduling";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = url ? test : test.skip;
const start = new Date("2026-01-01T00:00:00.123Z");
const atMinute = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
afterEach(() => setSystemTime());

test("trigger identity ignores nested object key ordering but preserves listener order and filter values", () => {
  const cron = { type: "cron", schedule: "@every 10m" };
  const slack = { type: "slack", channel: "#alerts", match: { kind: "keyword", keyword: "deploy" } };
  const original = { type: "group", listeners: [slack, cron] };
  const reorderedKeys = { listeners: [
    { match: { keyword: "deploy", kind: "keyword" }, channel: "#alerts", type: "slack" },
    { schedule: "@every 10m", type: "cron" },
  ], type: "group" };
  expect(triggerIdentity(original)).toBe(triggerIdentity(reorderedKeys));
  expect(triggerIdentity(original)).not.toBe(triggerIdentity({ type: "group", listeners: [cron, slack] }));
  expect(triggerIdentity(original)).not.toBe(triggerIdentity({ type: "group", listeners: [
    { ...slack, match: { kind: "keyword", keyword: "incident" } }, cron,
  ] }));
  expect(triggerIdentity({ type: "github", events: ["pr-closed", "pr-merged"] })).not.toBe(
    triggerIdentity({ type: "github", events: ["pr-merged", "pr-closed"] })
  );
});

async function fixture() {
  setSystemTime(start);
  const db = createPrismaClient(url!);
  const botId = randomUUID(), roomId = randomUUID();
  const previousZone = await db.userTimeZoneSettings.findUnique({ where: { id: "global" } });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" }, create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  await db.bot.create({ data: {
    id: botId, name: "Schedule retest", defaultDirectory: "/tmp", status: "active", conversation: { create: {} },
  } });
  await db.channel.create({ data: {
    id: roomId, kind: "group", name: "Schedule retest",
    members: { create: { botId, ordinal: 0 } },
  } });
  const service = new RoutineService(db, {
    enqueueWake: async () => { throw new Error("No bot model transport in retest"); },
    createGroupRound: async (tx, input) => tx.channelRound.create({ data: {
      channelId: input.channelId, triggerMessageId: input.triggerMessageId,
      rootMessageId: input.triggerMessageId,
    } }),
    advanceRound: async () => {},
  });
  const owner = { kind: "group" as const, id: roomId };
  const read = (id: string) => db.routine.findUniqueOrThrow({ where: { id } });
  const create = async (trigger: unknown) => String((await service.mutateOwner(owner, randomUUID(), null, {
    action: "create", name: "Retest cadence", prompt: "Original instructions", trigger,
  })).id);
  const update = (id: string, data: Record<string, unknown>) => service.mutateOwner(owner, randomUUID(), null, {
    action: "update", id, ...data,
  });
  const settle = (id: string) => db.routineExecution.updateMany({
    where: { routineId: id, status: { in: ["queued", "running"] } },
    data: { status: "completed", completedAt: new Date() },
  });
  return { db, service, owner, create, read, update, settle, close: async () => {
    await db.channel.delete({ where: { id: roomId } });
    await db.bot.delete({ where: { id: botId } });
    if (previousZone) await db.userTimeZoneSettings.update({ where: { id: "global" }, data: previousZone });
    else await db.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
    await db.$disconnect();
  } };
}

for (const event of [
  { type: "github", repo: "openai/example", events: ["pr-merged"], pr: 7 },
  { type: "slack", channel: "#alerts", match: { kind: "keyword", keyword: "deploy" } },
  { type: "email", inbox: "bot@example.com", from: ["@example.com"], requireAuthPass: false },
]) {
  integration(`unchanged full-trigger save preserves cadence in a mixed ${event.type}/interval group`, async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "group", listeners: [
        event, { type: "cron", schedule: "@every 10m" }, { type: "cron", schedule: "@every 15m" },
      ] });
      const before = await f.read(id);
      setSystemTime(atMinute(3));
      await f.update(id, { prompt: "Edited instructions", trigger: before.trigger });
      const after = await f.read(id);
      expect(after.trigger).toEqual(before.trigger);
      expect(after.scheduleAnchorAt).toEqual(before.scheduleAnchorAt);
      expect(after.nextRunAt).toEqual(before.nextRunAt);
      expect(after.revision).toBe(before.revision + 1);
      setSystemTime(atMinute(10));
      expect(await f.service.dispatchDue(atMinute(10))).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(atMinute(15));
    } finally { await f.close(); }
  });
}

integration("presentation-only save preserves a legacy null anchor until repair migrates its phase", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ type: "cron", schedule: "@every 10m" });
    const due = atMinute(17);
    await f.db.routine.update({ where: { id }, data: { scheduleAnchorAt: null, nextRunAt: due } });
    setSystemTime(atMinute(9));
    const presentation = { version: 1, trigger: { type: "cron", schedule: "@every 10m" } };
    await f.update(id, { presentation });
    expect(await f.read(id)).toMatchObject({ scheduleAnchorAt: null, nextRunAt: due, triggerPresentation: presentation });
    const before = await f.read(id);
    const revisionBefore = await f.db.routineRevision.findMany({ where: { routineId: id } });
    const preview = await repairRoutineScheduling(f.db, { now: atMinute(9) });
    expect(preview.errors).toEqual([]);
    expect(preview.changes).toEqual([{ id, from: due.toISOString(), to: due.toISOString(), anchor: due.toISOString(), applied: false }]);
    expect(await f.read(id)).toEqual(before);
    await repairRoutineScheduling(f.db, { now: atMinute(9), apply: true });
    expect(await f.read(id)).toMatchObject({ scheduleAnchorAt: due, nextRunAt: due, triggerPresentation: presentation });
    expect(await f.db.routineRevision.findMany({ where: { routineId: id } })).toEqual(revisionBefore);
    expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(0);
    expect((await repairRoutineScheduling(f.db, { now: atMinute(9), apply: true })).changes).toEqual([]);
  } finally { await f.close(); }
});

integration("a later-listener-only schedule edit establishes a new anchor with both listeners intact", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ type: "group", listeners: [
      { type: "cron", schedule: "@every 10m" }, { type: "cron", schedule: "@every 15m" },
    ] });
    setSystemTime(atMinute(3));
    await f.update(id, { trigger: { type: "group", listeners: [
      { type: "cron", schedule: "@every 10m" }, { type: "cron", schedule: "@every 17m" },
    ] } });
    expect((await f.read(id)).scheduleAnchorAt).toEqual(atMinute(3));
    for (const [due, next] of [[13, 20], [20, 23], [23, 33]]) {
      setSystemTime(atMinute(due!));
      expect(await f.service.dispatchDue(atMinute(due!))).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(atMinute(next!));
    }
    expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(3);
  } finally { await f.close(); }
});

for (const status of ["completed", "skipped", "failed"] as const) {
  integration(`stale ${status} occurrence stays deduplicated after schedule edit and metadata revisions`, async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 10m" });
      setSystemTime(atMinute(10));
      expect(await f.service.dispatchDue(atMinute(10))).toBe(1);
      await f.db.routineExecution.updateMany({ where: { routineId: id }, data: { status, completedAt: atMinute(10) } });
      const receipt = await f.db.routineExecution.findFirstOrThrow({ where: { routineId: id } });
      setSystemTime(atMinute(12));
      await f.update(id, { schedule: "@every 7m" });
      await f.update(id, { prompt: "Instructions after edit" });
      expect((await f.read(id)).scheduleAnchorAt).toEqual(atMinute(12));
      await f.db.routine.update({ where: { id }, data: { nextRunAt: atMinute(10) } });
      setSystemTime(atMinute(14));
      expect(await f.service.dispatchDue(atMinute(14))).toBe(0);
      expect((await f.read(id)).nextRunAt).toEqual(atMinute(19));
      expect(await f.db.routineExecution.findMany({ where: { routineId: id } })).toEqual([receipt]);
      setSystemTime(atMinute(19));
      expect(await f.service.dispatchDue(atMinute(19))).toBe(1);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(2);
      expect((await f.read(id)).nextRunAt).toEqual(atMinute(26));
    } finally { await f.close(); }
  });
}

integration("manual and event receipts at the scheduled timestamp cannot suppress its scheduled occurrence", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ type: "group", listeners: [{ type: "webhook" }, { type: "cron", schedule: "@every 10m" }] });
    setSystemTime(atMinute(10));
    await f.service.runNowOwner(f.owner, id, randomUUID(), atMinute(10));
    await f.settle(id);
    await f.service.dispatchEvent(f.owner, { id: randomUUID(), source: "webhook", kind: "webhook", text: "same timestamp" });
    await f.settle(id);
    expect(await f.service.dispatchDue(atMinute(10))).toBe(1);
    const receipts = await f.db.routineExecution.findMany({ where: { routineId: id }, orderBy: { createdAt: "asc" } });
    expect(receipts.map((row) => row.kind)).toEqual(["test", "scheduled", "scheduled"]);
    expect(receipts.map((row) => row.scheduledFor)).toEqual([atMinute(10), atMinute(10), atMinute(10)]);
    expect(receipts.filter((row) => row.events === null)).toHaveLength(2);
    expect((await f.read(id)).nextRunAt).toEqual(atMinute(20));
  } finally { await f.close(); }
});

for (const state of ["schedule save", "pause", "quarantine"]) {
  integration(`repair apply respects an intervening ${state} after a preview`, async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 10m" });
      await f.db.routine.update({ where: { id }, data: { scheduleAnchorAt: null } });
      expect((await repairRoutineScheduling(f.db, { now: atMinute(1) })).changes).toHaveLength(1);
      setSystemTime(atMinute(2));
      if (state === "schedule save") await f.update(id, { schedule: "@every 7m" });
      else if (state === "pause") await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "pause", id });
      else await f.db.routine.update({ where: { id }, data: { validationError: "Unfinished definition", enabled: false, nextRunAt: null } });
      const before = await f.read(id);
      const result = await repairRoutineScheduling(f.db, { now: atMinute(3), apply: true });
      expect(result).toEqual({ mode: "apply", changes: [], errors: [] });
      expect(await f.read(id)).toEqual(before);
    } finally { await f.close(); }
  });
}

integration("repair isolates a malformed legacy schedule and still migrates healthy rows", async () => {
  const f = await fixture();
  try {
    const broken = await f.create({ type: "cron", schedule: "@every 10m" });
    const healthy = await f.create({ type: "group", listeners: [
      { type: "cron", schedule: "@every 15m" }, { type: "cron", schedule: "@every 10m" },
    ] });
    await f.db.routine.update({ where: { id: broken }, data: {
      trigger: { type: "cron", schedule: "invalid old cron" }, scheduleAnchorAt: null,
    } });
    await f.db.routine.update({ where: { id: healthy }, data: {
      scheduleAnchorAt: null, nextRunAt: atMinute(15), createdAt: start,
    } });
    const before = await f.read(broken);
    const result = await repairRoutineScheduling(f.db, { now: atMinute(1), apply: true });
    expect(result.errors).toEqual([{ id: broken, code: "schedule_repair_failed" }]);
    expect(result.changes).toEqual([{ id: healthy, from: atMinute(15).toISOString(), to: atMinute(10).toISOString(), anchor: start.toISOString(), applied: true }]);
    expect(await f.read(broken)).toEqual(before);
    expect(await f.read(healthy)).toMatchObject({ scheduleAnchorAt: start, nextRunAt: atMinute(10) });
    expect(await f.db.routineExecution.count({ where: { routineId: { in: [broken, healthy] } } })).toBe(0);
  } finally { await f.close(); }
});

integration("additive scheduling columns remain nullable without defaults in the deployed schema", async () => {
  const db = createPrismaClient(url!);
  try {
    const columns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>(Prisma.sql`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Routine'
      AND column_name IN ('scheduleAnchorAt', 'validationError') ORDER BY column_name
    `);
    expect(columns).toEqual([
      { column_name: "scheduleAnchorAt", is_nullable: "YES", column_default: null },
      { column_name: "validationError", is_nullable: "YES", column_default: null },
    ]);
  } finally { await db.$disconnect(); }
});
