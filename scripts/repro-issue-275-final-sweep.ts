// Final bounded audit: new minimized cases plus independent calendar invariants.
// Known failures are characterized; sweep mismatches outside those cases fail.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/repro-issue-275-final-sweep.ts [name-filter]
import assert from "node:assert/strict";
import { setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAuditHarness } from "./repro-issue-275-harness";
import { followUserTimeZone, nextRoutineRun, nextRoutineTriggerRun, normalizeRoutineSchedule, normalizeRoutineMutationTrigger } from "../packages/messaging/src/routines";
import { groupRoutineState } from "../packages/messaging/src/group-routine-state";
import { reconcileRoutineExecution } from "../packages/messaging/src/automation-results";
import {
  DEFAULT_ROUTINE_SCHEDULE, parseRoutineSchedule, routineScheduleValue,
  routineScheduleDrafts, routineTriggerValue, routinePresentationValue, routineDraftValid,
  type RoutineScheduleDraft,
} from "../apps/desktop/src/renderer/lib/routines";

const { db, fixture, close } = await createAuditHarness();
const anchor = new Date("2026-11-12T00:00:00Z");
const cron = (schedule: string) => ({ type: "cron", schedule });
const group = (...listeners: unknown[]) => ({ type: "group", listeners });
const iso = (value: Date | null) => value?.toISOString() ?? null;
const outcomes: Array<{ name: string; result: string }> = [];
const sweepResults: unknown[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  setSystemTime(anchor);
  try { await fn(); outcomes.push({ name, result: "confirmed" }); console.log(`CONFIRMED: ${name}`); }
  catch (error) { outcomes.push({ name, result: "FAILED" }); console.error(name, error); }
  finally {
    setSystemTime();
    await db.userTimeZoneSettings.upsert({ where: { id: "global" }, create: { id: "global", detected: "UTC" }, update: { detected: "UTC", override: null } });
  }
}
const detailDrafts = async (f: Awaited<ReturnType<typeof fixture>>) => routineScheduleDrafts(await f.service.detail(f.botId, f.routineId));
const saveAsEditor = async (f: Awaited<ReturnType<typeof fixture>>, zone = "UTC") => {
  const drafts = await detailDrafts(f);
  return f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, prompt: "Only the prompt was edited", trigger: routineTriggerValue(drafts, zone), presentation: routinePresentationValue(drafts) });
};

// An independent minute-by-minute wall-clock oracle. It does not call
// cron-parser, normalizeRoutineSchedule, nextRoutineRun, or the group helper.
function fieldValues(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, rawStep] = part.split("/");
    const step = rawStep ? Number(rawStep) : 1;
    const ends = range === "*" ? [min, max] : range!.split("-").map(Number);
    const start = ends[0]!, end = ends[1] ?? (rawStep ? max : start);
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
function referenceNext(expression: string, zone: string, after: Date) {
  const [m, h, d, mo, w] = expression.split(/\s+/) as [string, string, string, string, string];
  const minutes = fieldValues(m, 0, 59), hours = fieldValues(h, 0, 23), days = fieldValues(d, 1, 31), months = fieldValues(mo, 1, 12);
  const weekdays = new Set([...fieldValues(w, 0, 7)].map(n => n === 7 ? 0 : n));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const weekNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const end = after.getTime() + 8 * 86400_000;
  for (let ms = Math.floor(after.getTime() / 60000) * 60000 + 60000; ms <= end; ms += 60000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    const dom = days.has(Number(parts.day)), dow = weekdays.has(weekNames.indexOf(parts.weekday!));
    const dateMatches = d === "*" ? dow : w === "*" ? dom : dom || dow;
    if (minutes.has(Number(parts.minute)) && hours.has(Number(parts.hour)) && months.has(Number(parts.month)) && dateMatches) return new Date(ms);
  }
  return null;
}
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

try {
  await check("interval-first grouped schedules retain an invalid due time after a timezone change", async () => {
    const f = await fixture();
    try {
      const g = await f.group(group(cron("@every 1d"), cron("0 9 * * *")));
      const before = await db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      assert.equal(iso(before.nextRunAt), "2026-11-12T09:00:00.000Z");
      await db.$transaction(async tx => {
        await tx.userTimeZoneSettings.update({ where: { id: "global" }, data: { override: "America/New_York" } });
        await followUserTimeZone(tx, "America/New_York", anchor);
      });
      const after = await db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      assert.equal(iso(after.nextRunAt), "2026-11-12T09:00:00.000Z");
      assert.equal(iso(nextRoutineTriggerRun(after.trigger as any, after, anchor, "America/New_York")), "2026-11-12T14:00:00.000Z");
      assert.equal(await f.service.dispatchDue(before.nextRunAt!), 1);
    } finally { await f.cleanup(); }
  });

  await check("first timezone detection pins later floating schedules to the first pinned listener's zone", async () => {
    await db.userTimeZoneSettings.deleteMany();
    const f = await fixture();
    try {
      const g = await f.group(group(cron("CRON_TZ=Asia/Tokyo 0 18 * * *"), cron("0 8 * * *")));
      await db.$transaction(tx => f.messaging.updateUserTimeZone(tx, { detected: "America/New_York" }));
      const row = await db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      assert.equal((row.trigger as any).listeners[1].schedule, "CRON_TZ=Asia/Tokyo 0 8 * * *");
      assert.equal(iso(row.nextRunAt), "2026-11-12T08:00:00.000Z");
      assert.equal(iso(nextRoutineTriggerRun(row.trigger as any, row, anchor, "America/New_York")), "2026-11-12T09:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("first timezone detection misses floating cron listeners when an interval is first", async () => {
    await db.userTimeZoneSettings.deleteMany();
    const f = await fixture();
    try {
      const g = await f.group(group(cron("@every 1d"), cron("0 9 * * *")));
      await db.$transaction(tx => f.messaging.updateUserTimeZone(tx, { detected: "America/New_York" }));
      const row = await db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      assert.equal((row.trigger as any).listeners[1].schedule, "0 9 * * *");
      assert.equal(iso(nextRoutineTriggerRun(row.trigger as any, row, new Date("2026-11-12T09:00:00Z"), "America/New_York")), "2026-11-12T14:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  await check("a long valid cron accepted by the schedule API is truncated and soft-deleted by file sync", async () => {
    const schedule = [
      Array.from({ length: 12 }, (_, i) => i * 5).join(","),
      Array.from({ length: 24 }, (_, i) => i).join(","),
      Array.from({ length: 31 }, (_, i) => i + 1).join(","), "*", "*",
    ].join(" ");
    assert(schedule.length > 120 && schedule.length < 500);
    const f = await fixture({ schedule, enabled: true });
    try {
      assert.equal((await f.read()).enabled, true);
      assert.equal((await f.sync()).warnings.length, 1);
      assert((await f.read()).deletedAt);
    } finally { await f.cleanup(); }
  });

  for (const [label, original, rewritten] of [
    ["Sunday represented as 7 becomes Saturday", "0 9 * * 7", "0 9 * * 6"],
    ["a monthly-plus-weekly rule loses its weekday", "0 9 1 * 1", "0 9 1 * *"],
    ["an advanced rule loses its month-day constraint", "*/15 9-17 1,15 1,2 1,3", "*/15 9-17 * 1,2 1,3"],
  ]) {
    await check(`desktop prompt-only edit: ${label}`, async () => {
      const f = await fixture({ schedule: original! });
      try {
        await saveAsEditor(f);
        assert.equal((await f.read()).scheduleText, `CRON_TZ=UTC ${rewritten}`);
        assert.notEqual(iso(nextRoutineRun(normalizeRoutineSchedule(original!, "UTC"), anchor)), iso(nextRoutineRun(await f.read(), anchor)));
      } finally { await f.cleanup(); }
    });
  }

  await check("desktop edit makes a valid hourly */60 cron unsavable by clamping its step to 59", async () => {
    const f = await fixture({ schedule: "*/60 * * * *" });
    try {
      const drafts = await detailDrafts(f);
      assert.equal(routineScheduleValue(drafts[0]!), "*/59 * * * *");
      await assert.rejects(() => saveAsEditor(f), /5 minutes/);
    } finally { await f.cleanup(); }
  });

  await check("desktop prompt-only edit replaces an explicitly pinned schedule's timezone with the device zone", async () => {
    const f = await fixture({ schedule: "CRON_TZ=Asia/Tokyo 0 9 * * *" });
    try {
      await saveAsEditor(f, "America/New_York");
      assert.equal((await f.read()).scheduleText, "CRON_TZ=America/New_York 0 9 * * *");
    } finally { await f.cleanup(); }
  });

  await check("desktop-generated triggers ignore a settings timezone override and stay pinned across later changes", async () => {
    await db.userTimeZoneSettings.update({ where: { id: "global" }, data: { override: "America/New_York" } });
    const draft = { ...DEFAULT_ROUTINE_SCHEDULE, preset: "daily" as const, time: "09:00" };
    const f = await fixture({ trigger: routineTriggerValue([draft], "Asia/Tokyo"), enabled: true });
    try {
      assert.equal((await f.read()).timezone, "Asia/Tokyo");
      assert.equal((await f.read()).timezoneMode, "pinned");
      const before = (await f.read()).nextRunAt;
      await db.$transaction(async tx => {
        await tx.userTimeZoneSettings.update({ where: { id: "global" }, data: { override: "Europe/London" } });
        await followUserTimeZone(tx, "Europe/London", anchor);
      });
      assert.equal((await f.read()).timezone, "Asia/Tokyo");
      assert.deepEqual((await f.read()).nextRunAt, before);
    } finally { await f.cleanup(); }
  });

  await check("stale desktop presentation hides a file schedule edit and restores the old time on the next prompt edit", async () => {
    const draft = { ...DEFAULT_ROUTINE_SCHEDULE, preset: "daily" as const, time: "09:00" };
    const f = await fixture({ schedule: "0 9 * * *", presentation: routinePresentationValue([draft]) });
    try {
      const path = join(f.store.botDirectory(f.botId), "automations", (await f.read()).slug, "automation.json");
      const json = JSON.parse(await readFile(path, "utf8"));
      json.schedule = "0 10 * * *";
      await writeFile(path, JSON.stringify(json));
      assert.deepEqual((await f.sync()).warnings, []);
      assert.equal((await f.read()).scheduleText, "0 10 * * *");
      assert.equal((await detailDrafts(f))[0]!.time, "09:00");
      await saveAsEditor(f);
      assert.equal((await f.read()).scheduleText, "CRON_TZ=UTC 0 9 * * *");
    } finally { await f.cleanup(); }
  });

  await check("desktop prompt-only edit of a mixed event/time routine silently removes its event listener", async () => {
    const f = await fixture({ trigger: group(cron("0 9 * * *"), { type: "webhook" }), enabled: true });
    try {
      assert.equal((await f.read()).scheduleKind, "cron"); // visible in the desktop time-routine list
      assert.equal((await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { id: randomUUID(), source: "webhook", kind: "received", text: "Before edit" })).length, 1);
      await saveAsEditor(f);
      assert.equal((await f.read()).trigger?.type, "cron");
      assert.equal((await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { id: randomUUID(), source: "webhook", kind: "received", text: "After edit" })).length, 0);
    } finally { await f.cleanup(); }
  });

  await check("advanced every-N-days weekday restrictions still generate weekend runs", async () => {
    const draft: RoutineScheduleDraft = { ...DEFAULT_ROUTINE_SCHEDULE, preset: "advanced", advancedDayMode: "weekdays", advancedWeekDays: [1, 2, 3, 4, 5], advancedEveryUnit: "d", advancedEveryAmount: 2, advancedFromTime: "09:00" };
    const schedule = routineScheduleValue(draft);
    assert.equal(schedule, "0 9 */2 * 1,2,3,4,5");
    const next = nextRoutineRun(normalizeRoutineSchedule(schedule, "UTC"), new Date("2026-11-14T12:00:00Z"));
    assert.equal(next.getUTCDay(), 0);
  });

  await check("two valid desktop cards can expand beyond the server's eight-listener limit", async () => {
    const drafts: RoutineScheduleDraft[] = [
      { ...DEFAULT_ROUTINE_SCHEDULE, preset: "advanced", advancedTimeMode: "at-times", advancedTimes: ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] },
      { ...DEFAULT_ROUTINE_SCHEDULE, preset: "daily", time: "08:00" },
    ];
    assert(drafts.length <= 8 && drafts.every(schedule => routineDraftValid({ name: "Test", prompt: "Test", schedule })));
    const trigger = routineTriggerValue(drafts, "UTC");
    assert.equal((trigger.listeners as unknown[]).length, 9);
    assert.throws(() => normalizeRoutineMutationTrigger({ trigger }, "UTC"), /at most 8/);
  });

  await check("group routine overlap protection ends while its background shell is still running", async () => {
    const f = await fixture();
    try {
      const g = await f.group(cron("@every 5m"));
      const due = (await db.routine.findUniqueOrThrow({ where: { id: g.routineId } })).nextRunAt!;
      assert.equal(await f.service.dispatchDue(due), 1);
      // Claim at a real future clock so the created inbox is available.
      setSystemTime(due);
      const claimed = await f.worker.claim(f.botId);
      assert(claimed?.deliveryId);
      await db.runItem.create({ data: { runId: claimed.runId, kind: "command", status: "completed", content: { shellKind: "background", result: { details: { status: "running", outputPath: "/tmp/group-background.log" } } } } });
      await db.run.update({ where: { id: claimed.runId }, data: { status: "completed", completedAt: due } });
      await f.messaging.completeDelivery(claimed.deliveryId, "completed", undefined, claimed.runId);
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: g.routineId } });
      assert.equal(execution.status, "completed");
      assert.equal((await groupRoutineState(db as never, execution.channelMessageId!)).active, false);
      const next = (await db.routine.findUniqueOrThrow({ where: { id: g.routineId } })).nextRunAt!;
      assert.equal(await f.service.dispatchDue(next), 1);
      assert.equal(await db.routineExecution.count({ where: { routineId: g.routineId } }), 2);
    } finally { await f.cleanup(); }
  });

  await check("control: bot routines retain overlap protection while a background shell is running", async () => {
    const f = await fixture();
    try {
      const execution = await f.service.runNow(f.botId, f.routineId, randomUUID());
      const row = await db.routineExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await db.runItem.create({ data: { runId: row.runId!, kind: "command", status: "completed", content: { shellKind: "background", result: { details: { status: "running", outputPath: "/tmp/bot-background.log" } } } } });
      await db.run.update({ where: { id: row.runId! }, data: { status: "completed", completedAt: anchor } });
      assert.equal(await db.$transaction(tx => reconcileRoutineExecution(tx, row.runId!)), undefined);
      assert.equal((await db.routineExecution.findUniqueOrThrow({ where: { id: row.id } })).status, "queued");
    } finally { await f.cleanup(); }
  });

  await check("worker settlement rewrites event-run history as scheduled-run history", async () => {
    const f = await fixture({ trigger: { type: "webhook" }, enabled: true });
    try {
      await f.service.dispatchEvent({ kind: "bot", id: f.botId }, { id: randomUUID(), source: "webhook", kind: "received", text: "Event history probe" });
      assert.equal((await f.read()).runLedger[0].trigger, "event");
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: f.routineId } });
      await db.run.update({ where: { id: execution.runId! }, data: { status: "completed", completedAt: anchor } });
      await db.inboxEvent.updateMany({ where: { runId: execution.runId }, data: { status: "completed", completedAt: anchor } });
      await f.worker.recoverRoutineExecutions();
      assert.equal((await f.read()).runLedger[0].trigger, "schedule");
    } finally { await f.cleanup(); }
  });

  await check("sweep: desktop round trips introduce no failure classes beyond the minimized cases", () => {
    const counts: Record<string, number> = {};
    let accepted = 0, unchanged = 0, rejected = 0;
    for (const minute of ["0", "15", "*/5", "*/15", "*/60", "5,35"])
      for (const hour of ["*", "9", "9-17", "*/2"])
        for (const day of ["*", "1", "1,15", "*/2"])
          for (const month of ["*", "1,2"])
            for (const week of ["*", "1", "7", "1,3", "1-5", "MON"]) {
              const expression = `${minute} ${hour} ${day} ${month} ${week}`;
              try { normalizeRoutineSchedule(expression, "UTC"); } catch { rejected++; continue; }
              accepted++;
              const draft = parseRoutineSchedule(expression);
              const output = routineScheduleValue(draft);
              if (output === expression) { unchanged++; continue; }
              let known: string | null = null;
              if (draft.preset === "weekly" && week === "7") known = "Sunday alias clamped";
              if (["monthly", "advanced"].includes(draft.preset) && day !== "*" && week !== "*") known = "combined calendar constraint lost";
              if (draft.preset === "advanced" && Number(minute.slice(2)) >= 60 && minute.startsWith("*/")) known = "step clamped below valid input";
              assert(known, `NEW round-trip mismatch: ${expression} -> ${output}`);
              counts[known] = (counts[known] ?? 0) + 1;
            }
    const result = { kind: "desktop Cartesian sweep", accepted, unchanged, rejected, knownDefectVariants: counts };
    sweepResults.push(result); console.log(JSON.stringify(result));
  });

  // Two independent seeds and different dates: any new mismatch fails the
  // audit, rather than silently being counted as another confirmed bug.
  for (const seed of [275, 276]) {
    await check(`sweep: independent calendar and phased-interval invariants, seed ${seed}`, () => {
      const rng = random(seed);
      const zones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Lord_Howe", "Asia/Kathmandu"];
      const expressions = ["*/5 * * * *", "30 1 * * *", "30 2 * * *", "0 9 * * 1-5", "0 9 1 * 1", "0 9 29 2 *", "0 0 1 * *", "15 9-17 * * *"];
      const dates = seed === 275
        ? ["2026-03-08T06:59:00Z", "2026-11-01T05:30:00Z", "2026-10-25T00:30:00Z", "2028-02-28T23:59:00Z"]
        : ["2026-04-04T14:45:00Z", "2026-03-29T00:59:00Z", "2026-11-30T23:59:00Z", "2026-12-31T23:59:00Z"];
      let calendarCases = 0, groupCases = 0, phaseCases = 0;
      for (const zone of zones) for (const date of dates) {
        const after = new Date(date);
        const reference = new Map<string, Date | null>();
        for (const expression of expressions) {
          const expected = referenceNext(expression, zone, after);
          const actual = nextRoutineRun(normalizeRoutineSchedule(expression, zone), after);
          assert(actual > after);
          if (expected) assert.equal(iso(actual), iso(expected), `NEW calendar mismatch: ${zone} ${date} ${expression}`);
          else assert(actual.getTime() > after.getTime() + 8 * 86400_000);
          reference.set(expression, expected); calendarCases++;
        }
        const chosen = [...expressions].sort(() => rng() - 0.5).slice(0, 2 + Math.floor(rng() * 6));
        const expectedRuns = chosen.map(s => reference.get(s)).filter((v): v is Date => Boolean(v));
        if (expectedRuns.length) {
          const earliest = Math.min(...expectedRuns.map(d => d.getTime()));
          const trigger = group(...chosen.map(schedule => cron(`CRON_TZ=${zone} ${schedule}`)));
          const fallback = normalizeRoutineSchedule(`CRON_TZ=${zone} ${chosen[0]}`, "UTC");
          const actual = nextRoutineTriggerRun(trigger, fallback, after, zone);
          const reversed = nextRoutineTriggerRun(group(...[...chosen].reverse().map(schedule => cron(`CRON_TZ=${zone} ${schedule}`))), fallback, after, zone);
          assert.equal(actual.getTime(), earliest, "NEW grouped calendar mismatch");
          assert.equal(actual.getTime(), reversed.getTime(), "NEW order dependence in shared helper");
          groupCases++;
        }
      }
      for (let sample = 0; sample < 160; sample++) {
        const after = new Date(anchor.getTime() + Math.floor(rng() * 1e10));
        const listeners: Array<{ schedule: string; next: number }> = [];
        for (let n = 0, count = 1 + Math.floor(rng() * 8); n < count; n++) {
          const every = 5 + 5 * Math.floor(rng() * 72), phase = Math.floor(rng() * every);
          const intervalMs = every * 60000, phaseMs = phase * 60000;
          listeners.push({ schedule: `@every ${every}m/${phase}m`, next: (Math.floor((after.getTime() - phaseMs) / intervalMs) + 1) * intervalMs + phaseMs });
        }
        const trigger = group(...listeners.map(l => cron(l.schedule)));
        const fallback = normalizeRoutineSchedule(listeners[0]!.schedule, "UTC");
        assert.equal(nextRoutineTriggerRun(trigger, fallback, after, "UTC").getTime(), Math.min(...listeners.map(l => l.next)), "NEW phased interval mismatch");
        phaseCases++;
      }
      const result = { kind: "independent oracle sweep", seed, calendarCases, groupCases, phaseCases, unexpectedMismatches: 0 };
      sweepResults.push(result); console.log(JSON.stringify(result));
    });
  }

  console.log(JSON.stringify({ checks: outcomes.length, outcomes, sweepResults }));
  assert(outcomes.length > 0);
  assert(outcomes.every(o => o.result === "confirmed"));
} finally {
  setSystemTime();
  await close();
}
