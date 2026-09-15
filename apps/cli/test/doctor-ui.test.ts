import { describe, expect, test } from "bun:test";
import { doctorNextSteps, renderCompactDoctor, renderDoctor } from "../src/doctor-ui";
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
    const health = doctorNextSteps({
      ...fixture,
      commandDirectory: "/tmp/team",
      checks: [{ label: "OpenTeam health", level: "fail", detail: "Connection refused" }],
    });
    expect(health[0]).toContain("openteam status --dir '/tmp/team'");
    expect(health[0]).toContain("openteam logs --dir '/tmp/team'");
  });
  test.each([
    ["Platform", "x64 or arm64"],
    ["Memory", "8 GiB"],
    ["Disk", "Free space"],
    ["Installation directory", "writable directory"],
    ["Local ports", "reported port"],
    ["Secrets", "owner-only"],
    ["Secret values", "backup"],
    ["Compose configuration", "configuration files"],
    ["Network exposure", "openteam setup"],
    ["Public DNS", "public hostname"],
    ["TLS certificate", "openteam logs caddy"],
    ["Public endpoint", "reverse proxy"],
    ["Database", "openteam logs postgres"],
    ["Worker heartbeat", "openteam logs worker"],
    ["Bot workspace storage", "writable"],
    ["server container", "openteam logs server"],
  ])("gives a specific recovery action for %s in both reports", (label, action) => {
    const result: DoctorResult = {
      ...fixture,
      checks: [{ label, level: "fail", detail: "fixture failure" }],
    };
    for (const render of [renderDoctor, renderCompactDoctor])
      expect(render(result, { color: false }).replace(/\s+/g, " ")).toContain(action);
  });
  test("resolves Docker before recommending dependent setup and service actions", () => {
    const result: DoctorResult = {
      ...fixture,
      checks: [
        ...fixture.checks,
        { label: "Owner account", level: "fail", detail: "missing" },
        {
          label: "Docker daemon",
          level: "fail",
          detail: "unreachable",
          action: "Open Docker Desktop and run docker info.",
        },
      ],
    };
    const steps = doctorNextSteps(result);
    expect(steps[0]).toContain("Open Docker Desktop");
    expect(steps.join(" ")).not.toContain("openteam start");
    expect(steps.join(" ")).not.toContain("openteam setup");
    expect(steps.join(" ")).not.toContain("openteam provider list");
  });
  test("first-time installation does not tell the user to restart an installation already in progress", () => {
    const result: DoctorResult = {
      ok: true,
      installed: false,
      checks: [
        {
          label: "Installation",
          level: "warn",
          detail: "First-time setup: the server has not been configured yet.",
        },
        {
          label: "Local ports",
          level: "warn",
          detail: "defaults will be checked after guided setup chooses the access mode",
        },
      ],
    };
    expect(renderCompactDoctor(result)).not.toContain("openteam install");
    expect(doctorNextSteps(result)).toEqual(["Run openteam install to complete the installation."]);
  });
  test("advice to choose a new directory does not reuse the current broken directory", () => {
    const steps = doctorNextSteps({
      ok: false,
      installed: false,
      commandDirectory: "/tmp/broken",
      checks: [{ label: "Installation directory", level: "fail", detail: "not writable" }],
    });
    expect(steps[0]).toContain("openteam install --dir <path>");
    expect(steps[0]).not.toContain("--dir '/tmp/broken'");
    expect(steps.at(-1)).toContain("openteam install --dir '/tmp/broken'");
  });
  test("quota failures recommend checking quota instead of reconnecting a provider", () => {
    const steps = doctorNextSteps({
      ...fixture,
      checks: [{ label: "AI connection", level: "fail", detail: "HTTP 429: quota exceeded" }],
    });
    expect(steps[0]).toContain("quota or billing");
    expect(steps[0]).not.toContain("openteam setup");
  });
});
