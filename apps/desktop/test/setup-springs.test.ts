import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SPRINGS,
  springAt,
  springCss,
  springDuration,
  springEasing,
} from "../src/renderer/components/openteam/setup/springs";

const peak = (spring: { response: number; damping: number }) => {
  let highest = 0;
  for (let t = 0; t < 2; t += 0.001) highest = Math.max(highest, springAt(spring, t));
  return highest;
};

test("a spring starts at rest and settles at its target", () => {
  for (const spring of Object.values(SPRINGS)) {
    expect(springAt(spring, 0)).toBeCloseTo(0, 6);
    expect(springAt(spring, springDuration(spring) / 1000)).toBeCloseTo(1, 2);
  }
});

test("critically damped springs never overshoot; the others overshoot a little", () => {
  expect(peak(SPRINGS.smooth)).toBeLessThanOrEqual(1);
  expect(peak(SPRINGS.gentle)).toBeLessThanOrEqual(1);
  expect(peak(SPRINGS.snappy)).toBeGreaterThan(1);
  expect(peak(SPRINGS.snappy)).toBeLessThan(1.01);
  expect(peak(SPRINGS.bouncy)).toBeGreaterThan(1.05);
  expect(peak(SPRINGS.bouncy)).toBeLessThan(1.12);
});

test("a stiffer spring settles sooner", () => {
  expect(springDuration(SPRINGS.snappy)).toBeLessThan(springDuration(SPRINGS.smooth));
  expect(springDuration(SPRINGS.smooth)).toBeLessThan(springDuration(SPRINGS.gentle));
  expect(springDuration(SPRINGS.smooth)).toBe(680);
});

test("the easing is a CSS linear() that runs from 0 to 1", () => {
  const easing = springEasing(SPRINGS.bouncy);
  expect(easing).toStartWith("linear(0, ");
  expect(easing).toEndWith(", 1)");
  const stops = easing.slice(7, -1).split(", ");
  const positions = stops.slice(1, -1).map((stop) => Number.parseFloat(stop.split(" ")[1] ?? ""));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(stops.some((stop) => Number.parseFloat(stop) > 1)).toBe(true);
});

test("setup.css carries the generated springs", () => {
  const css = readFileSync(
    new URL("../src/renderer/components/openteam/setup/setup.css", import.meta.url),
    "utf8"
  );
  const block = css.match(/\/\* springs:start[^*]*\*\/([\s\S]*?)\/\* springs:end \*\//)?.[1];
  // The formatter wraps the long easings; only the values matter.
  const values = (text: string) => text.replace(/\s+/g, "");
  expect(values(block ?? "")).toBe(values(springCss()));
});
