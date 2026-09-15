import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { doctorNextSteps, renderCompactDoctor, renderDoctor } from "../src/doctor-ui";
import { doctorScenarios } from "./fixtures/doctor-scenarios";
import { terminalTextWidth, wrapTerminalText } from "../src/terminal";

describe("doctor UI scenario matrix", () => {
  test.each(doctorScenarios)("$id: readable actions, status and layout", (scenario) => {
    const actions = doctorNextSteps(scenario.result).join(" ");
    if (scenario.action) expect(actions).toContain(scenario.action);
    if (scenario.avoid) expect(actions).not.toContain(scenario.avoid);
    for (const width of [24, 40, 60, 76, 90, 110]) {
      for (const render of [renderDoctor, renderCompactDoctor]) {
        const plain = render(scenario.result, { width, color: false });
        const colored = render(scenario.result, { width, color: true });
        expect(stripVTControlCharacters(colored)).toBe(plain);
        expect(plain).not.toContain("\x1b");
        expect(plain).not.toContain("undefined");
        expect(plain).not.toContain("NaN");
        expect(plain.split("\n").every((line) => terminalTextWidth(line) <= width)).toBe(true);
        expect(plain).not.toContain("sk-proj-doctorInvalid0123456789012345");
        if (!scenario.result.ok) expect(plain).toContain("NEXT STEPS");
        if (render === renderDoctor && !scenario.result.ok)
          expect(plain.indexOf("NEXT STEPS")).toBeLessThan(plain.indexOf("HOST & SETUP"));
      }
    }
  });

  test("wrapping keeps Unicode graphemes intact", () => {
    const original = "团队项目👩🏽‍💻Café".repeat(8);
    const graphemes = new Set(
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(original)].map(
        (s) => s.segment
      )
    );
    for (const width of [18, 24, 40]) {
      const lines = wrapTerminalText(original, width);
      expect(lines.join("")).toBe(original);
      expect(lines.every((line) => terminalTextWidth(line) <= width)).toBe(true);
      for (const line of lines)
        for (const { segment } of new Intl.Segmenter(undefined, {
          granularity: "grapheme",
        }).segment(line))
          expect(graphemes.has(segment)).toBe(true);
    }
  });

  test.each([
    Number.NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    1,
    10_000,
  ])("handles invalid or extreme terminal width %s", (width) => {
    const result = doctorScenarios[0]!.result;
    expect(() => renderDoctor(result, { width })).not.toThrow();
    expect(() => renderCompactDoctor(result, { width })).not.toThrow();
  });

  test.each([
    "docker-missing",
    "docker-stopped",
    "services-stopped",
    "provider-quota",
    "all-skipped",
    "healthy",
  ])("%s has a stable 80-column terminal layout", (id) => {
    const scenario = doctorScenarios.find((s) => s.id === id)!;
    expect(renderDoctor(scenario.result, { width: 80, color: false })).toMatchSnapshot();
    expect(renderCompactDoctor(scenario.result, { width: 40, color: false })).toMatchSnapshot();
  });
});
