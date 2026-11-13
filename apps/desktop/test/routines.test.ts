import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  parseRoutineSchedule,
  recoverRoutineCreation,
  routineScheduleDrafts,
  routineScheduleUpdate,
  routineScheduleValue,
  routineScheduleValues,
  routineTriggerValue,
  routineUpdateInput,
  synchronizeRoutineEnabled,
  type RoutineView,
} from "../src/renderer/lib/routines";

const routineWith = (schedules: string[], extra: Partial<RoutineView> = {}): RoutineView =>
  ({
    id: "routine",
    revision: 1,
    name: "Audit",
    prompt: "Inspect",
    enabled: true,
    schedule: schedules[0] ?? "",
    schedules,
    trigger: routineTriggerValue(schedules.map(parseRoutineSchedule)),
    triggerPresentation: null,
    ...extra,
  }) as RoutineView;

const withWebhook = (schedule: string) =>
  routineWith([schedule], {
    trigger: { type: "group", listeners: [{ type: "cron", schedule }, { type: "webhook", source: "alerts" }] },
  });

describe("routine editor preserves authored schedules", () => {
  test("unrelated edits omit the trigger; a schedule edit keeps event listeners and zones", () => {
    for (const schedule of ["0 9 * * 7", "0 9 1 * 1", "*/30 * 10 * 1", "*/60 * * * *", "CRON_TZ=Pacific/Honolulu 0 9 * * *"]) {
      const routine = withWebhook(schedule);
      expect(routineScheduleUpdate(routine, routineScheduleDrafts(routine))).toEqual({});
    }
    const routine = withWebhook("CRON_TZ=Pacific/Honolulu 0 9 * * *");
    const draft = { ...routineScheduleDrafts(routine)[0]!, time: "10:00" };
    expect(routineScheduleUpdate(routine, [draft]).trigger).toEqual({
      type: "group",
      listeners: [{ type: "cron", schedule: "CRON_TZ=Pacific/Honolulu 0 10 * * *" }, { type: "webhook", source: "alerts" }],
    });
  });

  test("a delayed content save built against the newer routine cannot undo Pause or Resume", () => {
    for (const enabled of [false, true]) {
      const old = routineWith(["0 9 * * *"], { enabled: !enabled });
      const queued = { name: "Renamed", prompt: "New instruction", schedules: routineScheduleDrafts(old) };
      expect(routineUpdateInput({ ...old, enabled, revision: 2 }, queued, enabled)).toEqual({
        name: "Renamed",
        prompt: "New instruction",
        expectedRevision: 2,
      });
    }
  });

  test("Pause after creation retries a revision conflict without overwriting newer content", async () => {
    const saved = routineWith(["@every 1h"]);
    const calls: Array<[number, boolean]> = [];
    const conflict = new Error("Revision changed");
    const result = await synchronizeRoutineEnabled(
      saved,
      () => false,
      async (value, enabled) => {
        calls.push([value.revision, enabled]);
        if (value.revision === 1) throw conflict;
        return { ...value, enabled, revision: 8 };
      },
      async () => ({ ...saved, prompt: "Externally edited", revision: 7 }),
      (error) => error === conflict
    );
    expect(result).toMatchObject({ prompt: "Externally edited", revision: 8, enabled: false });
    expect(calls).toEqual([[1, false], [7, false]]);
  });

  test("an uncertain create retries the original request then updates the recovered resource", async () => {
    const original = { name: "Original", prompt: "Old", enabled: true, schedule: "@every 1h" };
    const attempt = { clientId: "stable-create", input: original };
    const saved = routineWith(["@every 1h"]);
    const calls: unknown[] = [];
    const create = async (input: unknown, id: string) => {
      calls.push([input, id]);
      if (calls.length === 1) throw new Error("Response lost after commit");
      return saved;
    };
    const update = async (value: RoutineView) => ({ ...value, name: "Changed", prompt: "New", revision: 2 });
    await expect(recoverRoutineCreation(attempt, original, create, () => {}, update)).rejects.toThrow("Response lost");
    expect(await recoverRoutineCreation(attempt, { ...original, name: "Changed", prompt: "New" }, create, () => {}, update))
      .toMatchObject({ id: saved.id, name: "Changed", revision: 2 });
    expect(calls).toEqual([[original, "stable-create"], [original, "stable-create"]]);
  });
});

describe("routine schedule serialization", () => {
  test("round-trips every visible preset and builds cron listeners or a group", () => {
    for (const schedule of ["0 * * * *", "15 9 * * *", "15 9 * * 1-5", "15 9 * * 2", "15 9 20 * *", "@every 30m"])
      expect(routineScheduleValue(parseRoutineSchedule(schedule))).toBe(schedule);
    const weekdays = parseRoutineSchedule("0 9 * * 1-5");
    expect(routineTriggerValue([weekdays])).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
    expect(routineTriggerValue([weekdays, parseRoutineSchedule("@every 5m")], "America/New_York")).toEqual({
      type: "group",
      listeners: [{ type: "cron", schedule: "CRON_TZ=America/New_York 0 9 * * 1-5" }, { type: "cron", schedule: "@every 5m" }],
    });
  });

  test("Advanced keeps exact times without a cron cross-product, and 45-minute cadence spans midnight", () => {
    const atTimes = { ...DEFAULT_ROUTINE_SCHEDULE, preset: "advanced" as const, advancedTimeMode: "at-times" as const, advancedTimes: ["08:00", "09:15"] };
    expect(routineScheduleValues(atTimes)).toEqual(["0 8 * * *", "15 9 * * *"]);

    const schedules = routineScheduleValues({ ...DEFAULT_ROUTINE_SCHEDULE, preset: "advanced", advancedEveryAmount: 45 });
    const fires: number[] = [];
    // Independent minute-by-minute oracle over the generated minute/hour sets.
    for (let elapsed = 0; elapsed < 48 * 60; elapsed++) {
      const minute = elapsed % 60;
      const hour = Math.floor(elapsed / 60) % 24;
      const hit = schedules.some((schedule) => {
        const [minutes, hours] = schedule.split(" ");
        return minutes!.split(",").map(Number).includes(minute) && (hours === "*" || hours!.split(",").map(Number).includes(hour));
      });
      if (hit) fires.push(elapsed);
    }
    expect(fires).toEqual(Array.from({ length: 64 }, (_, index) => index * 45));
  });
});
