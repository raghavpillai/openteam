import { expect, test } from "bun:test";
import {
  THINKING_SLOT_HEIGHT,
  thinkingIndicatorPresence,
  thinkingIndicatorTransition,
} from "../src/thinking-indicator-presence";

test("the robot is invisible throughout space expansion and collapse", () => {
  for (let phase = 0; phase <= 2; phase += 0.01) {
    const pose = thinkingIndicatorPresence(phase);
    if (pose.height < THINKING_SLOT_HEIGHT) expect(pose.opacity).toBe(0);
    if (pose.opacity > 0) expect(pose.height).toBe(THINKING_SLOT_HEIGHT);
  }
  expect(thinkingIndicatorPresence(0)).toEqual({ height: 0, opacity: 0 });
  expect(thinkingIndicatorPresence(0.5)).toEqual({ height: 36, opacity: 0 });
  expect(thinkingIndicatorPresence(1.5)).toEqual({ height: 72, opacity: 0.5 });
  expect(thinkingIndicatorPresence(2)).toEqual({ height: 72, opacity: 1 });
});

test("opening expands before revealing; closing fades before reclaiming space", () => {
  const opening = thinkingIndicatorTransition(0, true, false);
  const closing = thinkingIndicatorTransition(2, false, false);
  expect(opening.map((step) => step.to)).toEqual([1, 2]);
  expect(closing.map((step) => step.to)).toEqual([1, 0]);
  expect(opening.every((step) => step.duration > 0)).toBe(true);
  expect(closing.every((step) => step.duration > 0)).toBe(true);
});

test("rapid stop and restart reverse from every partial phase without resetting space", () => {
  for (const phase of [0.05, 0.5, 0.95, 1, 1.05, 1.5, 1.95]) {
    for (const visible of [true, false]) {
      let previous = phase;
      for (const step of thinkingIndicatorTransition(phase, visible, false)) {
        expect(visible ? step.to > previous : step.to < previous).toBe(true);
        for (let i = 0; i <= 10; i++) {
          const pose = thinkingIndicatorPresence(previous + ((step.to - previous) * i) / 10);
          if (pose.height < THINKING_SLOT_HEIGHT) expect(pose.opacity).toBe(0);
        }
        previous = step.to;
      }
      expect(previous).toBe(visible ? 2 : 0);
    }
  }
});

test("Reduce Motion skips resizing motion while preserving the fade sequence", () => {
  for (const [phase, visible] of [
    [0, true],
    [2, false],
  ] as const) {
    const steps = thinkingIndicatorTransition(phase, visible, true);
    expect(steps.find((step) => step.curve === "space")?.duration).toBe(0);
    expect(steps.find((step) => step.curve !== "space")?.duration).toBeGreaterThan(0);
  }
  expect(thinkingIndicatorTransition(0, false, false)).toEqual([]);
  expect(thinkingIndicatorTransition(2, true, false)).toEqual([]);
});
