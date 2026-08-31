import { describe, expect, test } from "bun:test";
import { nextRoutineRun, nextRoutineTriggerRun, normalizeRoutineSchedule } from "../src/routines";

describe("routine schedules", () => {
  test("normalizes aliases and pinned time zones", () => {
    const daily = normalizeRoutineSchedule("CRON_TZ=America/New_York @daily", "UTC");
    expect(daily).toMatchObject({
      cronExpression: "0 0 * * *",
      scheduleKind: "cron",
      timezoneMode: "pinned",
      timezone: "America/New_York",
    });
    expect(() => normalizeRoutineSchedule("CRON_TZ=Not/A_Zone 0 9 * * *", "UTC")).toThrow(
      "Invalid IANA time zone"
    );
  });

  test("supports bounded elapsed intervals", () => {
    const interval = normalizeRoutineSchedule("@every 30m", "UTC");
    expect(interval.intervalSeconds).toBe(1800);
    expect(nextRoutineRun(interval, new Date("2026-08-25T12:00:00Z"))).toEqual(
      new Date("2026-08-25T12:30:00Z")
    );
    expect(
      normalizeRoutineSchedule("@every 30s", "UTC", {
        enforceMinimum: false,
      }).intervalSeconds
    ).toBe(30);
    expect(
      normalizeRoutineSchedule("@every 1h/5m", "UTC", {
        enforceMinimum: false,
      }).intervalSeconds
    ).toBe(60 * 60);
    const phased = normalizeRoutineSchedule("@every 1h/5m", "UTC", {
      enforceMinimum: false,
    });
    expect(nextRoutineRun(phased, new Date("2026-08-25T12:00:00Z"))).toEqual(
      new Date("2026-08-25T12:05:00Z")
    );
    expect(() => normalizeRoutineSchedule("@every 1m", "UTC")).toThrow("5 minutes");
  });

  test("rejects six-field and overly frequent cron", () => {
    expect(() => normalizeRoutineSchedule("0 0 7 * * *", "UTC")).toThrow("five fields");
    expect(() => normalizeRoutineSchedule("*/2 * * * *", "UTC")).toThrow("5 minutes");
  });

  test("selects the earliest occurrence across grouped time triggers", () => {
    const fallback = normalizeRoutineSchedule("0 9 * * 1-5", "UTC", {
      enforceMinimum: false,
    });
    const next = nextRoutineTriggerRun(
      {
        type: "group",
        listeners: [
          { type: "cron", schedule: "0 9 * * 1-5" },
          { type: "cron", schedule: "30 8 * * 1-5" },
        ],
      },
      fallback,
      new Date("2026-08-28T08:00:00Z")
    );
    expect(next).toEqual(new Date("2026-08-28T08:30:00Z"));
  });

  test("matches Grok wall-clock behavior through DST gaps and folds", () => {
    const springGap = normalizeRoutineSchedule("30 2 * * *", "Asia/Jerusalem", {
      enforceMinimum: false,
    });
    expect(nextRoutineRun(springGap, new Date("2026-03-26T20:00:00Z"))).toEqual(
      new Date("2026-03-27T23:30:00Z")
    );

    const fallFold = normalizeRoutineSchedule("30 1 * * *", "Asia/Jerusalem", {
      enforceMinimum: false,
    });
    const firstFold = nextRoutineRun(fallFold, new Date("2026-10-24T20:00:00Z"));
    const secondFold = nextRoutineRun(fallFold, firstFold);
    expect(firstFold).toEqual(new Date("2026-10-24T22:30:00Z"));
    expect(secondFold).toEqual(new Date("2026-10-24T23:30:00Z"));
  });
});
