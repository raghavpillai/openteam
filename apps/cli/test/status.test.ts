import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseArguments } from "../src/arguments";
import { helpFor } from "../src/help";
import { collectStatus } from "../src/status";
import { renderStatus, statusState } from "../src/status-ui";
import { terminalTextWidth } from "../src/terminal";
import {
  normalizeStatusPreview,
  statusFixture,
  statusScenarios,
} from "./fixtures/status-scenarios";

test("health is a true alias, including both help forms and durable update progress", () => {
  for (const args of [[], ["--dir", "/tmp/team"], ["--json-progress"], ["--help"], ["-h"]]) {
    expect(parseArguments(["health", ...args])).toEqual(parseArguments(["status", ...args]));
  }
  expect(parseArguments(["help", "health"])).toEqual(parseArguments(["help", "status"]));
  expect(() => parseArguments(["health", "--force"])).toThrow("Unknown option for status");
  expect(() => parseArguments(["helth"])).toThrow('Did you mean "health"?');
  expect(helpFor("global")).toContain("health        Alias for status");
  expect(helpFor("status")).toContain("does not start containers or send an AI request");
});

describe("status and health reports", () => {
  test.each(statusScenarios)("%s: %s", async (id, _title, state, expected) => {
    const f = statusFixture(id);
    try {
      const report = await collectStatus(f.paths, f.runner);
      expect(statusState(report)).toBe(state);
      expect(renderStatus(report, { width: 110, color: false })).toContain(expected);
      for (const width of [24, 40, 60, 76, 90, 110])
        for (const color of [false, true]) {
          const output = renderStatus(report, { width, color });
          expect(output.split("\n").every((line) => terminalTextWidth(line) <= width)).toBe(true);
          if (!color) expect(output).not.toContain("\x1b");
        }
      if (state === "STATUS UNKNOWN" || state === "NOT INSTALLED") {
        expect(report.services).toBeNull();
        expect(report.health).toBeNull();
        expect(f.requests).toEqual([]);
      } else {
        expect(f.requests.every((path) => path === "/api/v0/health")).toBe(true);
      }
      for (const { options } of f.runner.calls) {
        expect(options?.timeoutMs).toBeGreaterThan(0);
        expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
        expect(options?.killSignal).toBe("SIGKILL");
      }
      for (const [file, content] of f.before) expect(readFileSync(file, "utf8")).toBe(content);
      // The fixture runner rejects every command outside the read-only allowlist.
      expect(
        f.runner.calls.filter((call) => call.args.includes("json")).length
      ).toBeLessThanOrEqual(1);
      if (
        [
          "healthy",
          "live-ready",
          "database-unavailable",
          "stopped",
          "invalid-json",
          "starting",
          "job-failed",
          "not-installed",
        ].includes(id)
      ) {
        const normalized = normalizeStatusPreview(report, f);
        expect(
          renderStatus(normalized, { width: id === "starting" ? 40 : 90, color: false })
        ).toMatchSnapshot(id);
      }
    } finally {
      f.cleanup();
    }
  });

  test("keeps credentials and terminal control sequences out of status output", async () => {
    const f = statusFixture("healthy");
    try {
      const report = await collectStatus(f.paths, f.runner);
      report.issue = {
        label: "Docker",
        detail: "failed",
        diagnostic: "https://owner:secret-value@example.test\x1b[2J AUTH_TOKEN=secret-token-value",
      };
      report.directory = "/tmp/团队 👩🏽‍💻 é";
      for (const width of [24, 40, 90]) {
        const output = renderStatus(report, { width, color: false });
        expect(output).not.toContain("secret-value");
        expect(output).not.toContain("secret-token-value");
        expect(output).not.toContain("\x1b");
        expect(output.split("\n").every((line) => terminalTextWidth(line) <= width)).toBe(true);
      }
    } finally {
      f.cleanup();
    }
  });
});
