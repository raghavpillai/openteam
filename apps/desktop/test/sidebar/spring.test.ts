import { expect, test } from "bun:test";
import {
  sidebarSpring,
  sidebarSpringFrames,
  pinnedSpringFrames,
} from "../../src/renderer/lib/sidebar-spring";
test("sidebar spring preserves initial displacement and velocity through interruptions", () => {
  expect(sidebarSpring(174, -200, 0)).toEqual({ value: 174, velocity: -200 });
  const before = sidebarSpring(174, 0, 75);
  const resumed = sidebarSpring(before.value + 58, before.velocity, 0);
  expect(resumed.value - 58).toBeCloseTo(before.value, 10);
  expect(resumed.velocity).toBeCloseTo(before.velocity, 10);
  expect(Math.abs(sidebarSpring(174, 0, 400).value)).toBeLessThan(0.01);
});
test("row and pin motion have intermediate frames and exact settled endpoints", () => {
  const spring = sidebarSpringFrames(0, 174);
  expect(spring.frames.length).toBeGreaterThan(20);
  expect(spring.frames[0]?.translate).toBe("0px 174px");
  expect(spring.frames.at(-1)?.translate).toBe("0px 0px");
  expect(spring.duration).toBeLessThan(600);
  const enter = pinnedSpringFrames(false),
    exit = pinnedSpringFrames(true);
  expect(enter.frames[0]).toEqual({ opacity: 0, scale: 0.85 });
  expect(enter.frames.at(-1)).toEqual({ opacity: 1, scale: 1 });
  expect(exit.frames[0]).toEqual({ opacity: 1, scale: 1 });
  expect(exit.frames.at(-1)).toEqual({ opacity: 0, scale: 0.85 });
});
