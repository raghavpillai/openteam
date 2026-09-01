import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { runDoctor } from "../src/doctor";
import { uninstallCommand, updateCommand, UPDATE_PROGRESS_PREFIX } from "../src/lifecycle";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { readUpdateState } from "../src/update-safety";

class HealthyDockerRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  private failedStart = false;

  constructor(
    private readonly failPull = false,
    private readonly failFirstStart = false
  ) {}

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
    if (args.includes("ps") && args.includes("--services")) {
      return { status: 0, stdout: "postgres\nserver\nworker\ncomputer\n", stderr: "" };
    }
    if (this.failPull && args.includes("pull")) {
      return { status: 1, stdout: "", stderr: "fixture pull failed" };
    }
    if (this.failFirstStart && !this.failedStart && args.includes("up")) {
      this.failedStart = true;
      return { status: 1, stdout: "", stderr: "fixture startup failed" };
    }
    if (args.includes("pg_dump") && options?.outputFile) {
      writeFileSync(options.outputFile, "-- OpenBot test database backup\nSELECT 1;\n", {
        mode: 0o600,
      });
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
      const version = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
        "OPENBOT_VERSION"
      );
      return Response.json({
        status: "ready",
        runtime: { agent: "missing" },
        release: { releaseVersion: version },
      });
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

const releaseFixture = () => {
  const compose =
    "name: openbot\nservices:\n  server:\n    image: example/openbot-server:${OPENBOT_VERSION}\nvolumes:\n  openbot_workspace:\n";
  const checksum = createHash("sha256").update(compose).digest("hex");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/openbot-compose.yaml")) return new Response(compose);
      if (path.endsWith("/SHA256SUMS")) {
        return new Response(`${checksum}  openbot-compose.yaml\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return [
    `--compose-url`,
    `${base}/openbot-compose.yaml`,
    "--checksum-url",
    `${base}/SHA256SUMS`,
    "--allow-unsigned",
  ];
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

  test("updates the full Compose release and emits every desktop progress phase", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    const messages: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      messages.push(values.map(String).join(" "));
    });
    try {
      await updateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", "--json-progress", ...releaseFixture()]),
        runner
      );
    } finally {
      log.mockRestore();
    }

    expect(readManifest(paths)?.version).toBe("1.3.0");
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENBOT_VERSION=1.3.0");
    expect(readUpdateState(paths)).toMatchObject({
      status: "complete",
      phase: "complete",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
    });
    expect(existsSync(readUpdateState(paths)?.backupPath ?? "")).toBe(true);
    expect(runner.calls.some((call) => call.args.includes("pull"))).toBe(true);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(true);
    const phases = messages
      .filter((message) => message.startsWith(UPDATE_PROGRESS_PREFIX))
      .map((message) => JSON.parse(message.slice(UPDATE_PROGRESS_PREFIX.length)).phase);
    expect(phases).toEqual([
      "checking",
      "downloading",
      "pulling",
      "backing-up",
      "restarting",
      "verifying",
      "complete",
    ]);
  });

  test("restores configuration and reports rollback when an update fails", async () => {
    const { paths } = fixture();
    const previousCompose = readFileSync(paths.compose, "utf8");
    const previousEnvironment = readFileSync(paths.environment, "utf8");
    const runner = new HealthyDockerRunner(true);
    const messages: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      messages.push(values.map(String).join(" "));
    });
    try {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", "--json-progress", ...releaseFixture()]),
          runner
        )
      ).rejects.toThrow("previous Compose configuration was restored");
    } finally {
      log.mockRestore();
    }

    expect(readFileSync(paths.compose, "utf8")).toBe(previousCompose);
    expect(readFileSync(paths.environment, "utf8")).toBe(previousEnvironment);
    expect(readManifest(paths)?.version).toBe("1.2.3");
    expect(messages.some((message) => message.includes('"phase":"rolling-back"'))).toBe(true);
    expect(runner.calls.at(-1)?.args).toContain("pull");
  });

  test("restores the database before restarting the prior release after startup fails", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner(false, true);
    await expect(
      updateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", ...releaseFixture()]),
        runner
      )
    ).rejects.toThrow("previous Compose configuration was restored and restarted");

    expect(runner.calls.some((call) => call.args.includes("dropdb"))).toBe(true);
    expect(runner.calls.some((call) => call.args.includes("createdb"))).toBe(true);
    expect(runner.calls.some((call) => Boolean(call.options?.inputFile))).toBe(true);
    const restoreIndex = runner.calls.findIndex((call) => Boolean(call.options?.inputFile));
    const stopIndexes = runner.calls
      .map((call, index) => (call.args.includes("stop") ? index : -1))
      .filter((index) => index >= 0);
    expect(stopIndexes).toHaveLength(2);
    expect(stopIndexes.at(-1)).toBeLessThan(restoreIndex);
    expect(readManifest(paths)?.version).toBe("1.2.3");
  });

  test("rejects downgrades and prereleases before downloading a release", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    await expect(
      updateCommand(paths, parseArguments(["update", "--version", "1.1.9"]), runner)
    ).rejects.toThrow("Refusing to downgrade");
    await expect(
      updateCommand(paths, parseArguments(["update", "--version", "1.3.0-rc.1"]), runner)
    ).rejects.toThrow("Refusing prerelease");
    expect(existsSync(paths.updateLock)).toBe(false);
    expect(readManifest(paths)?.version).toBe("1.2.3");
  });
});
