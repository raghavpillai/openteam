import { describe, expect, test } from "bun:test";
import {
  nextRoutineRun,
  nextRoutineTriggerRun,
  normalizeRoutineMutationTrigger,
  normalizeRoutineSchedule,
  RoutineService,
} from "../src/routines";

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

  test("accepts interval and weekday routines but rejects event integrations", () => {
    expect(normalizeRoutineMutationTrigger({ schedule: "@every 1m" }, "UTC")).toMatchObject({
      trigger: { type: "cron", schedule: "@every 1m" },
      schedule: { scheduleKind: "interval", intervalSeconds: 60 },
    });
    const weekday = normalizeRoutineMutationTrigger(
      {
        trigger: {
          type: "cron",
          schedule: "CRON_TZ=America/New_York 0 11 * * 1-5",
        },
      },
      "UTC"
    );
    expect(weekday).toMatchObject({
      trigger: {
        type: "cron",
        schedule: "CRON_TZ=America/New_York 0 11 * * 1-5",
      },
      schedule: {
        scheduleKind: "cron",
        cronExpression: "0 11 * * 1-5",
        timezoneMode: "pinned",
        timezone: "America/New_York",
      },
    });
    expect(
      nextRoutineTriggerRun(weekday.trigger, weekday.schedule, new Date("2026-09-02T14:59:00Z"))
    ).toEqual(new Date("2026-09-02T15:00:00Z"));
    expect(() => normalizeRoutineMutationTrigger({ trigger: { type: "webhook" } }, "UTC")).toThrow(
      "only support time-based schedules"
    );
    expect(() =>
      normalizeRoutineMutationTrigger(
        {
          trigger: {
            type: "group",
            listeners: [
              { type: "cron", schedule: "0 11 * * 1-5" },
              { type: "pagerduty", event: { case: "incidentAny" } },
            ],
          },
        },
        "UTC"
      )
    ).toThrow("only support time-based schedules");
  });

  test("matches Bot wall-clock behavior through DST gaps and folds", () => {
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

  test("looks up every canonical PostgreSQL UUID without requiring RFC variant bits", async () => {
    let queriedWhere: unknown;
    const channelId = "dec8b14f-402f-9e34-1ddd-a3ebb13c2329";
    const routineId = "a2b83ac9-45c9-e57b-fcbb-18da42d0de11";
    const service = new RoutineService(
      {
        routine: {
          findFirst: async ({ where }: { where: unknown }) => {
            queriedWhere = where;
            return { botId: null, channelId };
          },
        },
      } as never,
      { defaultTimeZone: "UTC" } as never
    );

    await expect(service.owner(routineId)).resolves.toEqual({ kind: "group", id: channelId });
    expect(queriedWhere).toMatchObject({ OR: [{ id: routineId }, { slug: routineId }] });
  });
});
