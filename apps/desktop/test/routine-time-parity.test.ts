import { describe, expect, test } from "bun:test";
import {
  formatRoutineExecutionTime,
  type RoutineExecutionView,
} from "../src/renderer/lib/routines";

const executionAt = (when: Date): RoutineExecutionView => ({
  id: "execution-1",
  routineId: "routine-1",
  runId: "run-1",
  kind: "scheduled",
  status: "completed",
  scheduledFor: when.toISOString(),
  enqueuedAt: when.toISOString(),
  startedAt: when.toISOString(),
  completedAt: when.toISOString(),
  skipReason: null,
  error: null,
  createdAt: when.toISOString(),
});

describe("Grok-compatible routine execution times", () => {
  const now = new Date(2026, 7, 31, 12, 50, 0);

  test("uses Grok's recent relative labels", () => {
    expect(formatRoutineExecutionTime(executionAt(new Date(2026, 7, 31, 12, 49, 31)), now)).toBe(
      "Just now"
    );
    expect(formatRoutineExecutionTime(executionAt(new Date(2026, 7, 31, 12, 48, 40)), now)).toBe(
      "1 min ago"
    );
    expect(formatRoutineExecutionTime(executionAt(new Date(2026, 7, 31, 12, 47, 0)), now)).toBe(
      "3 min ago"
    );
  });

  test("uses Grok's calendar labels for older runs", () => {
    expect(
      formatRoutineExecutionTime(executionAt(new Date(2026, 7, 31, 9, 15, 0)), now, "en-US")
    ).toBe("Today at 9:15 AM");
    expect(
      formatRoutineExecutionTime(executionAt(new Date(2026, 7, 30, 18, 24, 0)), now, "en-US")
    ).toBe("Yesterday at 6:24 PM");
    expect(
      formatRoutineExecutionTime(executionAt(new Date(2026, 7, 28, 18, 24, 0)), now, "en-US")
    ).toBe("Last Friday at 6:24 PM");
  });
});
