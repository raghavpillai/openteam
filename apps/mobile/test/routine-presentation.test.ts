import { describe, expect, test } from "bun:test";
import type { RoutineExecutionView, RoutineView } from "@openbot/contracts";
import {
  describeRoutineCronSchedule as describeRoutineSchedule,
  formatRoutineExecutionCalendarTime as formatRoutineExecutionTime,
  routineExecutionStatusPresentation as routineExecutionStatus,
  routineScheduleSummary as routineSummary,
} from "@openbot/product-core/routines";

const routine = (schedule: string, enabled = true): RoutineView =>
  ({ schedule, enabled }) as RoutineView;

const execution = (createdAt: string): RoutineExecutionView =>
  ({ createdAt, completedAt: null, startedAt: null }) as RoutineExecutionView;

describe("mobile routine presentation", () => {
  test("describes common schedules without exposing cron", () => {
    expect(describeRoutineSchedule("0 11 * * 1-5", "en-US")).toBe("Weekdays at 11:00 AM");
    expect(describeRoutineSchedule("17 9 * * *", "en-US")).toBe("Daily at 9:17 AM");
    expect(describeRoutineSchedule("30 8 * * 1", "en-US")).toBe("Mondays at 8:30 AM");
    expect(describeRoutineSchedule("@every 2h", "en-US")).toBe("Every 2 hours");
  });

  test("adds paused state only when needed", () => {
    expect(routineSummary(routine("0 11 * * 1-5", false), "en-US")).toBe(
      "Weekdays at 11:00 AM · Paused"
    );
    expect(routineSummary(routine("17 9 * * *"), "en-US")).toBe("Daily at 9:17 AM");
  });

  test("uses the reference calendar wording for history", () => {
    expect(
      formatRoutineExecutionTime(
        execution("2026-08-31T07:12:00"),
        new Date("2026-09-01T12:00:00"),
        "en-US"
      )
    ).toBe("Yesterday at 7:12 AM");
  });

  test("maps backend completion language to the user-facing result", () => {
    expect(routineExecutionStatus("completed")).toEqual({ label: "Succeeded", tone: "success" });
    expect(routineExecutionStatus("failed")).toEqual({ label: "Failed", tone: "danger" });
  });
});
