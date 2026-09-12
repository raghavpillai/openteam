import { describe, expect, test } from "bun:test";
import { hapticFeedbackAllowed, playHaptic } from "../src/haptics-core";

describe("supplemental haptic feedback", () => {
  test("opt-out suppresses every app lifecycle state", () => {
    for (const state of ["active", "inactive", "background", "unknown", null]) {
      expect(hapticFeedbackAllowed(false, state)).toBe(false);
    }
  });
  test("opt-in only allows feedback in a known foreground state", () => {
    expect(hapticFeedbackAllowed(true, "active")).toBe(true);
    for (const state of ["inactive", "background", "unknown", null]) {
      expect(hapticFeedbackAllowed(true, state)).toBe(false);
    }
  });
  test("plays once for a foreground interaction", async () => {
    let calls = 0;
    await playHaptic(async () => {
      calls += 1;
    }, true);
    expect(calls).toBe(1);
  });
  test("does not trigger native feedback after the app leaves the foreground", async () => {
    let calls = 0;
    await playHaptic(async () => {
      calls += 1;
    }, false);
    expect(calls).toBe(0);
  });
  test("absorbs rejected native calls so user actions can continue", async () => {
    await expect(
      playHaptic(async () => {
        throw new Error("Engine unavailable");
      }, true)
    ).resolves.toBeUndefined();
  });
  test("also absorbs synchronous unsupported-platform errors", async () => {
    await expect(
      playHaptic(() => {
        throw new Error("Unsupported platform");
      }, true)
    ).resolves.toBeUndefined();
  });
});
