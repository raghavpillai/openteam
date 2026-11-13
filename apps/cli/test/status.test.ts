import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectStatus } from "../src/status";
import { renderStatus, statusState } from "../src/status-ui";
import { terminalTextWidth } from "../src/terminal";
import { writeUpdateState } from "../src/update-safety";
import { fakeBin, runCli } from "./fixtures/harness";
import { statusFixture, statusScenarios } from "./fixtures/status-scenarios";

// Any Docker call is recorded; an active update must answer without probing Docker.
const docker = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENTEAM_TEST_CALLS"\nexit 1\n';

describe.skipIf(process.platform === "win32")("actual status CLI command", () => {
  test("the health alias reports an active update as JSON without probing Docker", async () => {
    const f = statusFixture("healthy");
    try {
      const calls = join(f.directory, "calls");
      writeUpdateState(f.paths, {
        schemaVersion: 1,
        fromVersion: "1.2.3",
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        jobId: "status-test",
        status: "running",
        phase: "pulling",
        message: "Downloading server images",
        targetVersion: "1.2.4",
      });
      const { stdout, stderr, code } = await runCli(
        ["health", "--dir", f.paths.directory, "--json-progress"],
        { PATH: fakeBin(f.directory, { docker }), TERM: "dumb", OPENTEAM_TEST_CALLS: calls }
      );
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.startsWith("@@OPENTEAM_UPDATE@@")).toBe(true);
      expect(JSON.parse(stdout.slice("@@OPENTEAM_UPDATE@@".length))).toMatchObject({
        phase: "pulling",
        version: "1.2.4",
      });
      expect(existsSync(calls)).toBe(false);
      expect(f.requests).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});

describe("status and health reports", () => {
  test.each(statusScenarios)("%s: %s", async (id, _title, state, expected) => {
    const f = statusFixture(id);
    try {
      const report = await collectStatus(f.paths, f.runner);
      expect(statusState(report)).toBe(state);
      expect(renderStatus(report, { width: 110, color: false })).toContain(expected);
      // Status repeats the username the apps sign in with, once setup has created it.
      if (id === "healthy")
        expect(renderStatus(report, { width: 110, color: false })).toMatch(/Username\s+owner\n/);
      if (state === "STATUS UNKNOWN" || state === "NOT INSTALLED") {
        expect(report.services).toBeNull();
        expect(report.health).toBeNull();
        expect(f.requests).toEqual([]);
      } else {
        expect(f.requests.every((path) => path === "/api/v0/health")).toBe(true);
      }
      for (const { options } of f.runner.calls)
        expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
      // The fixture runner rejects every command outside the read-only allowlist.
      for (const [file, content] of f.before) expect(readFileSync(file, "utf8")).toBe(content);
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
