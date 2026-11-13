import { describe, expect, test } from "bun:test";
import {
  runOwesUserDelivery,
  terminalGroupRoutineExecutionStatus,
  terminalRoutineExecutionStatus,
} from "../src/worker";

describe("routine execution restart reconciliation", () => {
  test("redrives only interrupted wakes that owe the user a visible delivery", () => {
    for (const origin of ["user", "bootstrap", "connector", "handoff_resume", "broadcast"] as const)
      expect(runOwesUserDelivery(origin)).toBe(true);
    for (const origin of ["agent", "group", "routine", "event", "background_revival"] as const)
      expect(runOwesUserDelivery(origin)).toBe(false);
  });

  test("maps terminal linked runs and group rounds without terminating live ones", () => {
    for (const [run, execution] of [
      ["completed", "completed"], ["failed", "failed"], ["interrupted", "failed"], ["cancelled", "cancelled"],
      ["queued", null], ["running", null], ["waiting_approval", null],
    ] as const)
      expect(terminalRoutineExecutionStatus(run)).toBe(execution);
    for (const [round, deliveries, execution] of [
      ["queued", [], null], ["running", ["completed"], null], ["failed", ["completed"], "failed"], ["completed", [], "completed"],
      ["completed", ["completed", "failed"], "failed"], ["completed", ["failed", "skipped"], "failed"],
    ] as const)
      expect(terminalGroupRoutineExecutionStatus(round, [...deliveries])).toBe(execution);
  });
});
