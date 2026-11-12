import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ApiError } from "@openteam/contracts";
import { triggerIdentity } from "../src/automation-trigger";
import {
  nextRoutineRun,
  nextRoutineTriggerRun,
  normalizeRoutineMutationTrigger,
  normalizeRoutineSchedule,
  RoutineService,
  routineScheduleAnchor,
} from "../src/routines";

afterEach(() => setSystemTime());

describe("routine schedules", () => {
  test("explicit UTC and Tokyo schedules keep their zones on a New York installation", () => {
    const now = new Date("2026-09-24T13:00:00Z");
    const utc = normalizeRoutineSchedule("CRON_TZ=UTC 0 9 * * *", "America/New_York");
    const tokyo = normalizeRoutineSchedule("CRON_TZ=Asia/Tokyo 0 9 * * *", "America/New_York");
    expect(utc).toMatchObject({ timezone: "UTC", timezoneMode: "pinned" });
    expect(tokyo).toMatchObject({ timezone: "Asia/Tokyo", timezoneMode: "pinned" });
    expect(nextRoutineRun(utc, now).toISOString()).toBe("2026-09-25T09:00:00.000Z");
    expect(nextRoutineRun(tokyo, now).toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });
  test.each([
    "@every nonsense",
    "@every 5m/5m",
    "@every 5m/invalid",
    "0 0 7 * * *",
    "61 9 * * *",
    "0 0 30 2 *",
    "CRON_TZ=Not/A_Zone 0 9 * * *",
  ])("classifies invalid schedule %s as a client error", (schedule) => {
    let failure: unknown;
    try {
      normalizeRoutineSchedule(schedule, "UTC");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 400, code: "invalid_routine_schedule" });
  });

  test.each(["@every 1m", "*/2 * * * *", "0,3 9 * * *"])("refuses %s with the five-minute floor reason", (schedule) => {
    expect(() => normalizeRoutineSchedule(schedule, "UTC")).toThrow(
      expect.objectContaining({ status: 400, code: "routine_schedule_too_frequent", message: "routine schedules must be at least 5 minutes apart." })
    );
  });

  test("long intervals are accepted", () => {
    expect(normalizeRoutineSchedule("@every 40d", "UTC").intervalSeconds).toBe(40 * 86_400);
  });

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

  test("accepts interval, weekday, event, and mixed listeners", () => {
    expect(normalizeRoutineMutationTrigger({ schedule: "@every 5m" }, "UTC")).toMatchObject({
      trigger: { type: "cron", schedule: "@every 5m" },
      schedule: { scheduleKind: "interval", intervalSeconds: 300 },
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
    expect(normalizeRoutineMutationTrigger({ trigger: { type: "webhook" } }, "UTC")).toMatchObject({ schedule: { scheduleKind: "event" } });
    expect(
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
    ).toMatchObject({ schedule: { scheduleKind: "cron" }, trigger: { type: "group" } });
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
      {} as never
    );

    await expect(service.owner(routineId)).resolves.toEqual({ kind: "group", id: channelId });
    expect(queriedWhere).toMatchObject({ id: routineId });
  });
});

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

test("trigger identity ignores object key order but not listener order or filter values", () => {
  const cron = { type: "cron", schedule: "@every 10m" };
  const slack = { type: "slack", channel: "#alerts", match: { kind: "keyword", keyword: "deploy" } };
  const original = { type: "group", listeners: [slack, cron] };
  expect(triggerIdentity(original)).toBe(triggerIdentity({ listeners: [
    { match: { keyword: "deploy", kind: "keyword" }, channel: "#alerts", type: "slack" },
    { schedule: "@every 10m", type: "cron" },
  ], type: "group" }));
  expect(triggerIdentity(original)).not.toBe(triggerIdentity({ type: "group", listeners: [cron, slack] }));
  expect(triggerIdentity(original)).not.toBe(triggerIdentity({ type: "group", listeners: [{ ...slack, match: { kind: "keyword", keyword: "incident" } }, cron] }));
});
