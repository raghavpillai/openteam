import { describe, expect, test } from "bun:test";
import { doctorNextSteps, renderDoctor } from "../src/doctor-ui";
import type { DoctorResult } from "../src/doctor";

const fixture: DoctorResult = {
  ok: false,
  installed: true,
  elapsedMs: 4200,
  checks: [
    { label: "Compose services", level: "fail", detail: "not running: server, worker, computer" },
    {
      label: "AI connection",
      level: "warn",
      detail: "Not tested; start the server and computer first",
    },
    {
      label: "Installation directory",
      level: "pass",
      detail: "/a/very/long/installation/path/that/must/wrap/without/overflow",
    },
  ],
};
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
describe("doctor dashboard", () => {
  test.each([24, 40, 76, 90, 110])("fits a %d-column terminal with and without color", (width) => {
    for (const color of [true, false]) {
      const text = renderDoctor(fixture, { width, color });
      expect(
        plain(text)
          .split("\n")
          .every((line) => line.length <= width)
      ).toBe(true);
      expect(text).toContain("NEEDS ATTENTION");
      if (!color) expect(text).not.toContain("\x1b");
    }
  });
  test("preserves all details and strips secrets and terminal control injection", () => {
    const secret = "sk-proj-doctorInvalid0123456789012345";
    const text = renderDoctor(
      {
        ...fixture,
        checks: [
          { label: "Database", level: "fail", detail: `Invalid API key ${secret}\x1b[2J\rspoof` },
        ],
      },
      { color: false }
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
  });
  test("prioritizes install, setup, or start according to the installation state", () => {
    expect(doctorNextSteps({ ...fixture, installed: false })[0]).toContain("openteam install");
    expect(
      doctorNextSteps({
        ...fixture,
        checks: [...fixture.checks, { label: "Owner account", level: "fail", detail: "missing" }],
      })[0]
    ).toContain("openteam setup");
    expect(doctorNextSteps(fixture)[0]).toContain("openteam start");
  });
  test("does not label an uninstalled system ready", () => {
    expect(renderDoctor({ ok: true, installed: false, checks: [] })).toContain("SETUP NEEDED");
  });
  test("recovery commands retain a custom installation path with shell-safe quoting", () => {
    const steps = doctorNextSteps({ ...fixture, commandDirectory: "/tmp/team's $HOME" });
    expect(steps[0]).toContain("openteam start --dir '/tmp/team'\\''s $HOME'");
  });
});
