import { describe, expect, test } from "bun:test";
import { CronExpressionParser } from "cron-parser";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  routineScheduleValues,
  type RoutineScheduleDraft,
} from "../../../apps/desktop/src/renderer/lib/routines";

const localCache = new Map<
  string,
  Array<{ timestamp: number; month: number; day: number; weekday: number; minute: number }>
>();
const localMinutes = (anchor: string, timeZone: string) => {
  const key = `${anchor}:${timeZone}`;
  if (localCache.has(key)) return localCache.get(key)!;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const start = Date.parse(anchor);
  const result = Array.from({ length: 48 * 60 }, (_, index) => {
    const timestamp = start + (index + 1) * 60_000;
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
    );
    return {
      timestamp,
      month: Number(parts.month),
      day: Number(parts.day),
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
      minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
  });
  localCache.set(key, result);
  return result;
};

const calendarOracle = (draft: RoutineScheduleDraft, anchor: string, zone: string) => {
  const from = Number(draft.advancedFromTime.slice(0, 2)) * 60;
  const through = (Number(draft.advancedToTime.slice(0, 2)) + 1) * 60;
  const atTimes = new Set(
    draft.advancedTimes.map((time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)))
  );
  return localMinutes(anchor, zone)
    .filter((local) => {
      if (draft.advancedMonths.length && !draft.advancedMonths.includes(local.month)) return false;
      if (draft.advancedDayMode === "weekdays" && !draft.advancedWeekDays.includes(local.weekday))
        return false;
      if (draft.advancedDayMode === "month-days" && !draft.advancedMonthDays.includes(local.day))
        return false;
      return draft.advancedTimeMode === "at-times"
        ? atTimes.has(local.minute)
        : local.minute >= from &&
            local.minute < through &&
            (local.minute - from) %
              (draft.advancedEveryAmount * (draft.advancedEveryUnit === "h" ? 60 : 1)) ===
              0;
    })
    .map((local) => local.timestamp);
};

const cronOccurrences = (draft: RoutineScheduleDraft, anchor: string, zone: string) => {
  const end = Date.parse(anchor) + 48 * 3_600_000;
  const result = new Set<number>();
  for (const expression of routineScheduleValues(draft)) {
    const parser = CronExpressionParser.parse(expression, {
      currentDate: new Date(anchor),
      tz: zone,
    });
    while (true) {
      const next = parser.next().getTime();
      if (next > end) break;
      result.add(next);
    }
  }
  return [...result].sort((left, right) => left - right);
};

const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const base: RoutineScheduleDraft = { ...DEFAULT_ROUTINE_SCHEDULE, preset: "advanced" };

describe("independent editor calendar oracle", () => {
  test("96 varied calendar cases preserve cadence and restrictions across leap/month/year boundaries", () => {
    const amounts = [5, 10, 15, 20, 30, 45];
    const windows = [
      [0, 23],
      [0, 0],
      [8, 17],
      [22, 23],
      [23, 23],
      [8, 8],
      [1, 3],
    ];
    const zones = ["UTC", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe"];
    const anchors = ["2028-02-28T00:00:00Z", "2026-12-31T00:00:00Z", "2027-04-30T00:00:00Z"];
    for (let index = 0; index < 96; index++) {
      const [from, to] = windows[index % windows.length]!;
      const draft: RoutineScheduleDraft = {
        ...base,
        advancedEveryAmount: amounts[index % amounts.length]!,
        advancedFromTime: clock(from!),
        advancedToTime: clock(to!),
        advancedDayMode:
          index % 3 === 0 ? "every-day" : index % 3 === 1 ? "weekdays" : "month-days",
        advancedWeekDays: [1, 3, 5],
        advancedMonthDays: [1, 28, 29, 31],
        advancedMonths: index % 5 === 0 ? [1, 2, 12] : [],
        ...(index % 7 === 0
          ? { advancedTimeMode: "at-times", advancedTimes: ["00:00", "08:15", "23:45"] }
          : {}),
        ...(index % 11 === 0
          ? { advancedEveryUnit: "h", advancedEveryAmount: [1, 2, 3, 4, 6, 8, 12][index % 7]! }
          : {}),
      };
      const anchor = anchors[Math.floor(index / 4) % anchors.length]!;
      const zone = zones[index % zones.length]!;
      expect({ index, actual: cronOccurrences(draft, anchor, zone) }).toEqual({
        index,
        actual: calendarOracle(draft, anchor, zone),
      });
    }
  });

  test("24 post-transition windows match local calendar intent on both New York DST dates", () => {
    for (const anchor of ["2027-03-14T00:00:00Z", "2027-11-07T00:00:00Z"]) {
      for (const amount of [5, 10, 15, 20, 30, 45]) {
        for (const [from, to] of [
          [8, 17],
          [23, 23],
        ]) {
          const draft = {
            ...base,
            advancedEveryAmount: amount,
            advancedFromTime: clock(from!),
            advancedToTime: clock(to!),
          };
          expect(cronOccurrences(draft, anchor, "America/New_York")).toEqual(
            calendarOracle(draft, anchor, "America/New_York")
          );
        }
      }
    }
  });

  test("calendar phases retain cron's DST gap/overlap policy, not an elapsed-interval guarantee", () => {
    const draft = { ...base, advancedEveryAmount: 45 };
    const spring = cronOccurrences(draft, "2027-03-14T05:00:00Z", "America/New_York").slice(0, 4);
    // Cron moves the nonexistent02:15 phase to03:15. Keep this limitation explicit;
    // converting an existing calendar window into @every would change its intent.
    expect(spring.map((time) => new Date(time).toISOString())).toEqual([
      "2027-03-14T05:45:00.000Z",
      "2027-03-14T06:30:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T07:15:00.000Z",
    ]);
    const fall = cronOccurrences(draft, "2027-11-07T04:00:00Z", "America/New_York").slice(0, 3);
    expect(fall.map((time) => new Date(time).toISOString())).toEqual([
      "2027-11-07T04:45:00.000Z",
      "2027-11-07T05:30:00.000Z",
      "2027-11-07T07:15:00.000Z",
    ]);
  });
});
