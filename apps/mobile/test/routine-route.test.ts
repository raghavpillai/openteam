import { describe, expect, test } from "bun:test";
import {
  clearRoutineNavigation,
  pendingRoutineId,
  routineIdFromPathname,
  stageRoutineNavigation,
} from "../src/routine-route";

describe("routine route", () => {
  test("extracts and decodes the routine identity from the native path", () => {
    expect(routineIdFromPathname("/routine/channel-a/routine-a")).toBe("routine-a");
    expect(routineIdFromPathname("/routine/channel-a/routine%20a/")).toBe("routine a");
  });

  test("does not treat details or malformed encodings as routine destinations", () => {
    expect(routineIdFromPathname("/details/channel-a")).toBeNull();
    expect(routineIdFromPathname("/routine/channel-a/%E0%A4%A")).toBeNull();
  });

  test("keeps a modal-to-stack handoff until the matching routine consumes it", () => {
    stageRoutineNavigation("channel-a", "routine-a");
    expect(pendingRoutineId("channel-b")).toBeNull();
    expect(pendingRoutineId("channel-a")).toBe("routine-a");
    clearRoutineNavigation("channel-a", "routine-b");
    expect(pendingRoutineId("channel-a")).toBe("routine-a");
    clearRoutineNavigation("channel-a", "routine-a");
    expect(pendingRoutineId("channel-a")).toBeNull();
  });
});
