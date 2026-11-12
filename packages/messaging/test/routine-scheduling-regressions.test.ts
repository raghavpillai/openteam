import { describe, expect, test } from "bun:test";
import {
  nextRoutineRun,
  nextRoutineTriggerRun,
  normalizeRoutineMutationTrigger,
  normalizeRoutineSchedule,
  routineScheduleAnchor,
} from "../src/routines";

const anchor = new Date("2026-01-01T00:00:00Z");

describe("durable routine cadence", () => {
  test("relative listeners keep their independent phases", () => {
    const trigger = {
      type: "group",
      listeners: [
        { type: "cron", schedule: "@every 10m" },
        { type: "cron", schedule: "@every 15m" },
      ],
    };
    const fallback = normalizeRoutineSchedule("@every 10m", "UTC");
    let current = anchor;
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      current = nextRoutineTriggerRun(trigger, fallback, current, "UTC", anchor);
      times.push(current.toISOString());
    }
    expect(times).toEqual([
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:20:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:40:00.000Z",
    ]);
  });

  test("year-long downtime jumps directly to the original interval phase", () => {
    const schedule = normalizeRoutineSchedule("@every 5m", "UTC");
    expect(nextRoutineRun(schedule, new Date("2027-01-01T00:02:00Z"), anchor).toISOString()).toBe(
      "2027-01-01T00:05:00.000Z"
    );
  });

  test("legacy single intervals retain an edited due-time phase before their first run", () => {
    const savedDue = new Date("2026-01-01T00:17:00Z");
    const savedAnchor = routineScheduleAnchor(
      {
        scheduleAnchorAt: null,
        nextRunAt: savedDue,
        createdAt: anchor,
        trigger: { type: "cron", schedule: "@every 5m" },
      },
      false
    );
    expect(
      nextRoutineRun(
        normalizeRoutineSchedule("@every 5m", "UTC"),
        new Date("2026-01-01T00:18:00Z"),
        savedAnchor
      ).toISOString()
    ).toBe("2026-01-01T00:22:00.000Z");
  });

  test("legacy inferred future anchors preserve the next interval occurrence", () => {
    const savedAnchor = new Date("2026-01-01T17:30:00Z");
    expect(
      nextRoutineRun(
        normalizeRoutineSchedule("@every 30m", "UTC"),
        new Date("2026-01-01T17:05:00Z"),
        savedAnchor
      )
    ).toEqual(savedAnchor);
  });

  test("explicit phase remains epoch-aligned even with a definition anchor", () => {
    const schedule = normalizeRoutineSchedule("@every 1h/5m", "UTC");
    expect(
      nextRoutineRun(
        schedule,
        new Date("2026-01-01T00:02:00Z"),
        new Date("2025-12-31T23:23:00Z")
      ).toISOString()
    ).toBe("2026-01-01T00:05:00.000Z");
  });

  test("mixed cron and interval listeners retain elapsed phase across calendar ticks", () => {
    const trigger = {
      type: "group",
      listeners: [
        { type: "cron", schedule: "@every 15m" },
        { type: "cron", schedule: "10 * * * *" },
      ],
    };
    const fallback = normalizeRoutineSchedule("@every 15m", "UTC");
    const calendar = nextRoutineTriggerRun(trigger, fallback, anchor, "UTC", anchor);
    expect(calendar.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    expect(nextRoutineTriggerRun(trigger, fallback, calendar, "UTC", anchor).toISOString()).toBe(
      "2026-01-01T00:15:00.000Z"
    );
  });

  test("rejects an invalid Teams regex before enabling a listener", () => {
    expect(() =>
      normalizeRoutineMutationTrigger(
        {
          trigger: {
            type: "microsoftTeams",
            tenantId: "tenant",
            teamIds: ["team"],
            messageContains: "[",
            messageContainsIsRegex: true,
          },
        },
        "UTC"
      )
    ).toThrow("valid regular expression");
    expect(
      normalizeRoutineMutationTrigger(
        {
          trigger: {
            type: "microsoftTeams",
            tenantId: "tenant",
            teamIds: ["team"],
            messageContains: "alert.*",
            messageContainsIsRegex: true,
          },
        },
        "UTC"
      ).trigger
    ).toMatchObject({ messageContains: "alert.*" });
  });
});
