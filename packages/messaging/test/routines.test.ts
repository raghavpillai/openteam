import { describe, expect, test } from "bun:test";
import { nextRoutineRun, normalizeRoutineSchedule } from "../src/routines";

describe("routine schedules", () => {
  test("normalizes aliases and pinned time zones", () => {
    const daily = normalizeRoutineSchedule("CRON_TZ=America/New_York @daily", "UTC");
    expect(daily).toMatchObject({
      cronExpression: "0 0 * * *",
      scheduleKind: "cron",
      timezoneMode: "pinned",
      timezone: "America/New_York",
    });
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
});
