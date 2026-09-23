import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { nextRoutineRun, normalizeRoutineSchedule } from "../src/routines";

afterEach(() => setSystemTime());

describe("routine calendar and interval edge cases", () => {
  test("leap-day schedules can find an occurrence more than one year away", () => {
    const schedule = normalizeRoutineSchedule("0 9 29 2 *", "UTC");
    expect(nextRoutineRun(schedule, new Date("2026-09-22T06:00:00Z"))).toEqual(
      new Date("2028-02-29T09:00:00Z")
    );
  });

  test("explicit zero phase aligns an interval to its clock boundary", () => {
    const schedule = normalizeRoutineSchedule("@every 1h/0m", "UTC");
    expect(nextRoutineRun(schedule, new Date("2026-09-22T06:13:37Z"))).toEqual(
      new Date("2026-09-22T07:00:00Z")
    );
  });

  test("a short gap cannot hide beyond the first eight occurrences", () => {
    setSystemTime(new Date("2026-09-22T00:02:00Z"));
    expect(() =>
      normalizeRoutineSchedule("0,1,10,15,20,25,30,35,40,45,50,55 * * * *", "UTC")
    ).toThrow("5 minutes");
  });

  for (const [zone, expression, after, expected] of [
    ["America/New_York", "30 2 * * *", "2026-03-08T06:00:00Z", "2026-03-09T06:30:00Z"],
    ["America/New_York", "30 1 * * *", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
    ["Australia/Lord_Howe", "45 1 * * *", "2026-04-04T14:45:00Z", "2026-04-04T15:15:00Z"],
    ["Asia/Kathmandu", "0 9 * * *", "2026-09-22T00:00:00Z", "2026-09-22T03:15:00Z"],
    ["UTC", "0 0 1 1 *", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"],
    ["UTC", "0 9 31 * *", "2026-04-01T00:00:00Z", "2026-05-31T09:00:00Z"],
  ]) {
    test(`${zone} ${expression} after ${after}`, () => {
      expect(
        nextRoutineRun(normalizeRoutineSchedule(expression!, zone!), new Date(after!))
      ).toEqual(new Date(expected!));
    });
  }
});
