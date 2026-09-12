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
import * as ports from "../src/ports";
import {
  installCommand,
  startCommand,
  statusCommand,
  uninstallCommand,
  updateCommand,
  UPDATE_PROGRESS_PREFIX,
} from "../src/lifecycle";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { readUpdateState } from "../src/update-safety";

class HealthyDockerRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  running = ["postgres", "server", "worker", "computer"];
  publishedBy: Record<string, string> = {};
  tailscale = "{}";
  internalHealth = "";
  serviceHealth: Record<string, string> = {};
  extraStates: Array<{ Service: string; State: string; Health?: string; ExitCode?: number }> = [];
  stateFormat: "array" | "lines" = "lines";
  invalidState = false;
  onStart?: () => void;
  private failedStart = false;

  constructor(
    private readonly failPull = false,
    private readonly failFirstStart = false
  ) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "tailscale") return { status: 0, stdout: this.tailscale, stderr: "" };
    if (args.includes("exec") && args.includes("-e")) {
      return { status: 0, stdout: this.internalHealth, stderr: "" };
    }
    if (command === "docker" && args[0] === "--version") {
      return { status: 0, stdout: "Docker version 29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "info") {
      return { status: 0, stdout: "29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
    }
    if (args.includes("ps") && args.includes("json")) {
      const states = [
        ...this.running.map((Service) => ({
          Service,
          State: "running",
          Health: this.serviceHealth[Service] ?? "healthy",
        })),
        ...this.extraStates,
      ];
      return {
        status: 0,
        stdout: this.invalidState
          ? "invalid"
          : this.stateFormat === "array"
            ? JSON.stringify(states)
            : states.map((state) => JSON.stringify(state)).join("\n"),
        stderr: "",
      };
    }
    if (args.includes("ps") && args.includes("--services")) {
      return {
        status: 0,
        stdout: this.running.map((service) => `${service}\n`).join(""),
        stderr: "",
      };
    }
    const publishFilter = args.find((argument) => argument.startsWith("publish="));
    if (command === "docker" && args[0] === "ps" && publishFilter) {
      const line = this.publishedBy[publishFilter.slice("publish=".length)];
      return { status: 0, stdout: line ? `${line}\n` : "", stderr: "" };
    }
    if (this.failPull && args.includes("pull")) {
      return { status: 1, stdout: "", stderr: "fixture pull failed" };
    }
    if (this.failFirstStart && !this.failedStart && args.includes("up")) {
      this.failedStart = true;
      return { status: 1, stdout: "", stderr: "fixture startup failed" };
    }
    if (args.includes("up")) this.onStart?.();
    if (args.includes("pg_dump") && options?.outputFile) {
      writeFileSync(options.outputFile, "-- OpenTeam test database backup\nSELECT 1;\n", {
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

const fixture = (inference = "missing") => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-cli-lifecycle-"));
  temporaryDirectories.push(directory);
  const paths = installationPaths(directory);
  const server = Bun.serve({
    port: 0,
    fetch() {
      const version = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
        "OPENTEAM_VERSION"
      );
      return Response.json({
        status: "ready",
        runtime: { inference },
        release: { releaseVersion: version },
      });
    },
  });
  servers.push(server);
  const environment = replaceEnvironmentValue(
    createEnvironment({ version: "1.2.3" }),
    "OPENTEAM_API_PORT",
    String(server.port)
  );
  writeFileAtomic(
    paths.compose,
    `name: openteam\nservices:\n  server:\n    image: example/openteam-server:\${OPENTEAM_VERSION}\nvolumes:\n  openteam_workspace:\n`
  );
  writeFileAtomic(paths.environment, environment);
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.com/openteam-compose.yaml",
    installedAt: now,
    updatedAt: now,
    ownerUsername: "openteam",
  });
  return { directory, paths };
};

const releaseFixture = () => {
  const compose =
    "name: openteam\nservices:\n  server:\n    image: example/openteam-server:${OPENTEAM_VERSION}\nvolumes:\n  openteam_workspace:\n";
  const checksum = createHash("sha256").update(compose).digest("hex");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/openteam-compose.yaml")) return new Response(compose);
      if (path.endsWith("/SHA256SUMS")) {
        return new Response(`${checksum}  openteam-compose.yaml\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return [
    `--compose-url`,
    `${base}/openteam-compose.yaml`,
    "--checksum-url",
    `${base}/SHA256SUMS`,
    "--allow-unsigned",
  ];
};

describe("installed lifecycle", () => {
  test("start requires account setup even when containers are already healthy", async () => {
    for (const ownerUsername of [undefined, "  "]) {
      const { paths } = fixture();
      writeManifest(paths, { ...readManifest(paths)!, ownerUsername });
      const runner = new HealthyDockerRunner();
      await expect(startCommand(paths, runner)).rejects.toThrow(
        "account setup is incomplete. Run openteam setup"
      );
      expect(runner.calls).toHaveLength(0);
    }
  });

  test("explicit install automation can start before account setup", async () => {
    const { paths } = fixture();
    writeManifest(paths, { ...readManifest(paths)!, ownerUsername: undefined });
    const runner = new HealthyDockerRunner();
    await installCommand(paths, parseArguments(["install", "--no-setup"]), runner);
    expect(runner.calls.some((call) => call.args.includes("ps"))).toBe(true);
  });

  test("reports missing inference while allowing an owner to run the services", async () => {
    for (const inference of ["missing", "ready"]) {
      const { paths } = fixture(inference);
      const output: string[] = [];
      const log = spyOn(console, "log").mockImplementation((...values) => {
        output.push(values.join(" "));
      });
      try {
        await startCommand(paths, new HealthyDockerRunner());
      } finally {
        log.mockRestore();
      }
      expect(output.join("\n")).toContain("already running");
      expect(output.join("\n").includes("No AI provider is connected")).toBe(
        inference === "missing"
      );
    }
  });

  test("start reports the Tailscale conflict before running Compose up", async () => {
    const { paths } = fixture();
    const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
    const port = environment.get("OPENTEAM_API_PORT")!;
    writeFileAtomic(
      paths.environment,
      replaceEnvironmentValue(
        readFileSync(paths.environment, "utf8"),
        "OPENTEAM_BIND_HOST",
        "0.0.0.0"
      )
    );
    const runner = new HealthyDockerRunner();
    runner.tailscale = JSON.stringify({ TCP: { [port]: { TCPForward: `127.0.0.1:${port}` } } });
    await expect(startCommand(paths, runner)).rejects.toThrow(
      `Tailscale Serve already uses port ${port}`
    );
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
    expect(
      runner.calls
        .filter((call) => call.command === "tailscale")
        .every((call) => call.args.join(" ") === "serve status --json")
    ).toBe(true);
  });

  test("start fails promptly when a ready container has no reachable host listener", async () => {
    const { paths } = fixture();
    servers.at(-1)!.stop(true);
    const runner = new HealthyDockerRunner();
    runner.internalHealth = "ready\n";
    const started = Date.now();
    await expect(startCommand(paths, runner)).rejects.toThrow("ready inside Docker");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("repeated start checks preflight and reports already running without restarting services or setup jobs", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    runner.serviceHealth.worker = "";
    runner.extraStates = ["migrate", "workspace-init", "asset-store-init"].map((Service) => ({
      Service,
      State: "exited",
      ExitCode: 0,
    }));
    writeFileAtomic(
      paths.environment,
      replaceEnvironmentValue(
        readFileSync(paths.environment, "utf8"),
        "OPENTEAM_PUBLIC_URL",
        "http://100.64.0.5:8787"
      )
    );
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    try {
      await startCommand(paths, runner);
      runner.stateFormat = "array";
      await startCommand(paths, runner);
    } finally {
      log.mockRestore();
    }
    expect(output.filter((line) => line === "Checking startup ports…")).toHaveLength(2);
    expect(
      output.filter((line) => line.includes("OpenTeam is already running at http://127.0.0.1:"))
    ).toHaveLength(2);
    expect(
      output.filter((line) => line === "Network address: http://100.64.0.5:8787")
    ).toHaveLength(2);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("-e"))).toBe(false);
  });

  test("starts a missing worker even when the server health endpoint is ready", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    runner.running = ["server", "postgres", "computer"];
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    try {
      await startCommand(paths, runner);
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("partially running. Starting or checking: worker");
    expect(output.join("\n")).not.toContain("already running");
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);
  });

  test("does not skip startup for unhealthy services or failed setup jobs", async () => {
    for (const scenario of ["unhealthy", "failed-job", "wrong-version"]) {
      const { paths } = fixture();
      const runner = new HealthyDockerRunner();
      if (scenario === "unhealthy") runner.serviceHealth.worker = "unhealthy";
      else if (scenario === "failed-job")
        runner.extraStates = [{ Service: "migrate", State: "exited", ExitCode: 1 }];
      else {
        const manifest = readManifest(paths)!;
        writeManifest(paths, { ...manifest, version: "1.2.4" });
        runner.onStart = () =>
          writeFileAtomic(
            paths.environment,
            replaceEnvironmentValue(
              readFileSync(paths.environment, "utf8"),
              "OPENTEAM_VERSION",
              "1.2.4"
            )
          );
      }
      await startCommand(paths, runner);
      expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);
    }
  });

  test("reports a stopped installation and starts it", async () => {
    const { paths } = fixture();
    const port = Number(
      parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_API_PORT")
    );
    servers.at(-1)!.stop(true);
    const runner = new HealthyDockerRunner();
    runner.running = [];
    runner.onStart = () => {
      servers.push(
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: () => Response.json({ status: "ready", release: { releaseVersion: "1.2.3" } }),
        })
      );
    };
    // Viewer ports belong to real stacks on development machines; the fixture has no Docker listeners.
    const available = spyOn(ports, "portAvailable").mockResolvedValue(true);
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    try {
      await startCommand(paths, runner);
    } finally {
      available.mockRestore();
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("OpenTeam is stopped. Starting services…");
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);
  });

  test("does not report already running when service inspection is invalid", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    runner.invalidState = true;
    await expect(startCommand(paths, runner)).rejects.toThrow("invalid service state");
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("diagnoses forwarding after a short grace period when newly started containers are ready", async () => {
    const { paths } = fixture();
    servers.at(-1)!.stop(true);
    const runner = new HealthyDockerRunner();
    runner.running = ["computer", "postgres"];
    runner.internalHealth = "ready\n";
    const started = Date.now();
    await expect(startCommand(paths, runner)).rejects.toThrow("ready inside Docker");
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(true);
  }, 20_000);

  test("doctor validates Compose and reports missing model onboarding as a warning", async () => {
    const { paths } = fixture();
    const result = await runDoctor(paths, new HealthyDockerRunner());
    expect(result.ok).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.checks).toContainEqual({
      level: "warn",
      label: "Inference",
      detail: "status is missing; connect a model provider before starting a task",
    });
  });

  test("start refuses to race another OpenTeam stack that already answers on the API port", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    runner.running = ["postgres"];
    const port = parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_API_PORT");
    runner.publishedBy = { [String(port)]: "openteam-dev-server-1\topenteam-dev" };

    await expect(startCommand(paths, runner)).rejects.toThrow(
      "Another OpenTeam server is answering at http://127.0.0.1:" +
        `${port}, but this installation's server is not running. It is container openteam-dev-server-1 (Compose project openteam-dev). Stop that stack with \`docker compose -p openteam-dev down\``
    );
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);

    await expect(statusCommand(paths, runner)).rejects.toThrow(
      "Another OpenTeam server is answering"
    );
  });

  test("status flags a different release answering on the configured port", async () => {
    const { paths } = fixture();
    const runner = new HealthyDockerRunner();
    const manifest = readManifest(paths);
    if (!manifest) throw new Error("fixture manifest missing");
    writeManifest(paths, { ...manifest, version: "1.2.4" });

    await expect(statusCommand(paths, runner)).rejects.toThrow(
      "expected release 1.2.4, but 1.2.3 is responding"
    );
  });

  test("safe uninstall removes containers but preserves configuration", async () => {
    const { directory, paths } = fixture();
    const runner = new HealthyDockerRunner();
    await uninstallCommand(paths, parseArguments(["uninstall", "--yes"]), runner);
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENTEAM_CONTROL_TOKEN=");
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
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENTEAM_VERSION=1.3.0");
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
