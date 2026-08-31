import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import {
  createEnvironment,
  installationPaths,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { runDoctor } from "../src/doctor";
import { uninstallCommand } from "../src/lifecycle";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";

class HealthyDockerRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "docker" && args[0] === "--version") {
      return { status: 0, stdout: "Docker version 29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "info") {
      return { status: 0, stdout: "29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-cli-lifecycle-"));
  temporaryDirectories.push(directory);
  const paths = installationPaths(directory);
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ status: "ready", runtime: { agent: "missing" } });
    },
  });
  servers.push(server);
  const environment = replaceEnvironmentValue(
    createEnvironment({ version: "1.2.3" }),
    "OPENBOT_API_PORT",
    String(server.port)
  );
  writeFileAtomic(
    paths.compose,
    `name: openbot\nservices:\n  server:\n    image: example/openbot-server:\${OPENBOT_VERSION}\nvolumes:\n  openbot_workspace:\n`
  );
  writeFileAtomic(paths.environment, environment);
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.com/openbot-compose.yaml",
    installedAt: now,
    updatedAt: now,
    ownerUsername: "openbot",
  });
  return { directory, paths };
};

describe("installed lifecycle", () => {
  test("doctor validates Compose and reports missing model onboarding as a warning", async () => {
    const { paths } = fixture();
    const result = await runDoctor(paths, new HealthyDockerRunner());
    expect(result.ok).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.checks).toContainEqual({
      level: "warn",
      label: "Model authentication",
      detail: "runtime reports missing; complete OpenBot onboarding before running agents",
    });
  });

  test("safe uninstall removes containers but preserves configuration", async () => {
    const { directory, paths } = fixture();
    const runner = new HealthyDockerRunner();
    await uninstallCommand(paths, parseArguments(["uninstall", "--yes"]), runner);
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENBOT_CONTROL_TOKEN=");
    expect(readManifest(paths)?.uninstalledAt).toBeString();
    expect(directory).toBe(paths.directory);
    expect(runner.calls.at(-1)?.args).toContain("down");
    expect(runner.calls.at(-1)?.args).not.toContain("--volumes");
  });

  test("purge requires an explicit flag and removes the installation directory", async () => {
    const { directory, paths } = fixture();
    const runner = new HealthyDockerRunner();
    await uninstallCommand(paths, parseArguments(["uninstall", "--purge", "--yes"]), runner);
    expect(readManifest(paths)).toBeNull();
    expect(runner.calls.at(-1)?.args).toContain("--volumes");
    temporaryDirectories.splice(temporaryDirectories.indexOf(directory), 1);
  });
});
