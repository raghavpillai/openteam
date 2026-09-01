import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  parseRoutineSchedule,
  routineDraftValid,
  routinePresentationDrafts,
  routinePresentationValue,
  routineScheduleValue,
  routineScheduleValues,
  routineSummaryProjectionEqual,
  routineTriggerValue,
  type RoutineView,
} from "../src/renderer/lib/routines";

describe("Grok-compatible routine schedule editor", () => {
  test("round-trips every visible preset", () => {
    expect(routineScheduleValue(parseRoutineSchedule("0 * * * *"))).toBe("0 * * * *");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * *"))).toBe("15 9 * * *");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * 1-5"))).toBe("15 9 * * 1-5");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 * * 2"))).toBe("15 9 * * 2");
    expect(routineScheduleValue(parseRoutineSchedule("15 9 20 * *"))).toBe("15 9 20 * *");
    expect(routineScheduleValue(parseRoutineSchedule("@every 30m"))).toBe("@every 30m");
  });

  test("builds one cron listener or a Grok-style trigger group", () => {
    const weekdays = parseRoutineSchedule("0 9 * * 1-5");
    const daily = parseRoutineSchedule("0 17 * * *");
    expect(routineTriggerValue([weekdays])).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
    expect(routineTriggerValue([weekdays, daily])).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 9 * * 1-5" },
        { type: "cron", schedule: "0 17 * * *" },
      ],
    });
  });

  test("uses the exact summary copy and blocks incomplete drafts", () => {
    const weekdays = parseRoutineSchedule("0 9 * * 1-5");
    expect(describeRoutineSchedule(weekdays)).toBe("On weekdays at 9:00 AM");
    expect(
      routineDraftValid({ name: "Audit", prompt: "Inspect the queue", schedule: weekdays })
    ).toBe(true);
    expect(routineDraftValid({ name: "", prompt: "Inspect the queue", schedule: weekdays })).toBe(
      false
    );
    expect(routineDraftValid({ name: "Audit", prompt: "", schedule: weekdays })).toBe(false);
  });

  test("uses Grok's defaults and summary wording", () => {
    expect(describeRoutineSchedule({ ...DEFAULT_ROUTINE_SCHEDULE, preset: "weekly" })).toBe(
      "Every Monday at 8:00 AM"
    );
    expect(describeRoutineSchedule({ ...DEFAULT_ROUTINE_SCHEDULE, preset: "monthly" })).toBe(
      "Monthly on the 1st at 8:00 AM"
    );
    expect(describeRoutineSchedule({ ...DEFAULT_ROUTINE_SCHEDULE, preset: "interval" })).toBe(
      "Every 30 minutes"
    );
    expect(describeRoutineSchedule({ ...DEFAULT_ROUTINE_SCHEDULE, preset: "custom" })).toBe(
      "Every 30 minutes"
    );
    expect(
      describeRoutineSchedule({
        ...DEFAULT_ROUTINE_SCHEDULE,
        preset: "advanced",
        advancedDayMode: "weekdays",
      })
    ).toBe("Every 30 minutes on Monday");
    expect(
      describeRoutineSchedule({
        ...DEFAULT_ROUTINE_SCHEDULE,
        preset: "advanced",
        advancedDayMode: "weekdays",
        advancedTimeMode: "at-times",
      })
    ).toBe("Every Monday at 8:00 AM");
  });

  test("preserves exact Advanced times without creating a cron cross-product", () => {
    const advanced = {
      ...DEFAULT_ROUTINE_SCHEDULE,
      preset: "advanced" as const,
      advancedTimeMode: "at-times" as const,
      advancedTimes: ["08:00", "09:15"],
    };
    expect(routineScheduleValues(advanced)).toEqual(["0 8 * * *", "15 9 * * *"]);
    expect(routineTriggerValue([advanced])).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 8 * * *" },
        { type: "cron", schedule: "15 9 * * *" },
      ],
    });
  });

  test("round-trips the structured UI presentation independently of cron listeners", () => {
    const schedules = [
      {
        ...DEFAULT_ROUTINE_SCHEDULE,
        preset: "advanced" as const,
        advancedTimeMode: "at-times" as const,
        advancedTimes: ["08:00", "09:15"],
      },
    ];
    const presentation = JSON.parse(JSON.stringify(routinePresentationValue(schedules)));
    expect(routinePresentationDrafts(presentation)).toEqual(schedules);
    expect(routinePresentationDrafts({ version: 2, kind: "grok-time-routines" })).toBeNull();
    expect(
      routinePresentationDrafts({
        ...presentation,
        schedules: [{ ...presentation.schedules[0], time: "99:99" }],
      })
    ).toBeNull();
  });

  test("does not rebuild a large routine summary when a poll is visibly unchanged", () => {
    const routine = {
      id: "routine-1",
      revision: 2,
      name: "Audit",
      enabled: true,
      schedule: "0 9 * * 1-5",
      latestExecution: {
        id: "execution-1",
        status: "completed",
      },
    } as unknown as RoutineView;
    expect(routineSummaryProjectionEqual([routine], [{ ...routine }])).toBe(true);
    expect(
      routineSummaryProjectionEqual(
        [routine],
        [
          {
            ...routine,
            latestExecution: { ...routine.latestExecution, status: "running" },
          },
        ]
      )
    ).toBe(false);
  });
});
