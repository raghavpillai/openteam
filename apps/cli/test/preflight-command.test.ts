import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEnvironment, installationPaths } from "../src/config";
import { fakeBin, installStack, runCli, scratch } from "./fixtures/harness";

const s = scratch();

// All non-diagnostic commands fail closed: these tests must never pull images,
// inspect credentials, read running services, or mutate a Docker installation.
const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENTEAM_TEST_CALLS"
case "$*" in
  --version) printf 'Docker version 29.0.0\\n' ;;
  'info --format {{.ServerVersion}}')
    if [ "$OPENTEAM_TEST_CASE" = stopped ]; then
      printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n' >&2; exit 1
    fi
    printf '29.0.0\\n' ;;
  'compose version')
    if [ "$OPENTEAM_TEST_CASE" = compose-missing ]; then exit 1; fi
    if [ "$OPENTEAM_TEST_CASE" = compose-old ]; then printf 'Docker Compose version v1.29.2\\n'; else printf 'Docker Compose version v5.1.3\\n'; fi ;;
  *) printf 'Unexpected Docker command\\n' >&2; exit 99 ;;
esac
`;

describe.skipIf(process.platform === "win32")("install and setup preflight", () => {
  // install and setup share one preflight; cover each failure once across both entry points.
  test.each([
    ["install", false, "missing", "Docker is required."],
    ["install", false, "compose-old", "2.20.0"],
    ["setup", true, "stopped", "could not connect to its engine"],
  ] as const)("%s (installed: %s), %s Docker, stops before changes", async (command, installed, scenario, message) => {
    const directory = s.dir("openteam-preflight-");
    const bin = fakeBin(directory, scenario === "missing" ? {} : { docker });
    const target = join(directory, "server installation");
    const paths = installed
      ? installStack(target, { environment: createEnvironment({ version: "0.0.1" }) }).paths
      : installationPaths(target);
    const before = new Map<string, string>();
    if (installed)
      for (const file of [paths.compose, paths.environment, paths.manifest])
        before.set(file, readFileSync(file, "utf8"));
    const calls = join(directory, "calls");
    const { code, output } = await runCli([command, "--dir", paths.directory], {
      PATH: bin,
      OPENTEAM_TEST_CASE: scenario,
      OPENTEAM_TEST_CALLS: calls,
    });
    expect(code).toBe(2);
    expect(output).toContain(message);
    // Missing Docker gets one short answer; other failures get the paused report.
    expect(output).toContain(scenario === "missing" ? "Then run: openteam setup --dir" : "paused");
    for (const text of ["Unexpected Docker command", "Downloading", "Password"])
      expect(output).not.toContain(text);
    for (const [file, body] of before) expect(readFileSync(file, "utf8")).toBe(body);
    if (!installed) expect(existsSync(paths.directory)).toBe(false);
    if (existsSync(calls))
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "--version",
        "info --format {{.ServerVersion}}",
        "compose version",
      ]);
  });

  test("fresh setup runs preflight and asks for a terminal before downloading", async () => {
    const directory = s.dir("openteam-setup-first-run-");
    const target = join(directory, "installation");
    const { code, output } = await runCli(["setup", "--dir", target], {
      PATH: fakeBin(directory, { docker }),
      OPENTEAM_TEST_CALLS: join(directory, "calls"),
    });
    expect(code).toBe(2);
    expect(output).toContain("Preflight checks passed");
    expect(output).toContain("interactive terminal");
    expect(output).not.toContain("Downloading");
    expect(existsSync(target)).toBe(false);
  });
});
