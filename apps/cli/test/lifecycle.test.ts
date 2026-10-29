import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import * as config from "../src/config";
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
import type { SetupPrompter } from "../src/setup";
import { UPDATE_BUSY_MESSAGE } from "../src/update-gate";
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

const fixture = (inference = "missing", activity?: (request: Request) => Response) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-cli-lifecycle-"));
  temporaryDirectories.push(directory);
  const paths = installationPaths(directory);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (activity && new URL(request.url).pathname === "/api/v0/internal/busy-bots")
        return activity(request);
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

describe("fresh install", () => {
  test("asks every setup question before pulling images, then starts and points to the apps", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-fresh-install-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(join(directory, "installation"));
    const health = Bun.serve({
      port: 0,
      fetch() {
        const version = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
          "OPENTEAM_VERSION"
        );
        return Response.json({
          status: "ready",
          runtime: { inference: "missing" },
          release: { releaseVersion: version },
        });
      },
    });
    servers.push(health);
    // Keep the new installation's health checks on the fixture instead of port 8787.
    const original = config.createEnvironment;
    const environment = spyOn(config, "createEnvironment").mockImplementation((options) =>
      replaceEnvironmentValue(original(options), "OPENTEAM_API_PORT", String(health.port))
    );
    const runner = new HealthyDockerRunner();
    const answers = [
      "2",
      "Raghav-P",
      "correct horse battery staple",
      "correct horse battery staple",
      "yes",
    ];
    const prompts: Array<{ prompt: string; calls: number; manifest: boolean }> = [];
    const ask = async (prompt: string) => {
      prompts.push({ prompt, calls: runner.calls.length, manifest: existsSync(paths.manifest) });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`No answer for ${prompt}`);
      return answer;
    };
    const prompter: SetupPrompter = { question: ask, secret: ask, close() {} };
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await installCommand(
        paths,
        parseArguments(["install", ...releaseFixture()]),
        runner,
        prompter
      );
    } finally {
      log.mockRestore();
      write.mockRestore();
      environment.mockRestore();
    }

    expect(answers).toEqual([]);
    expect(prompts.every((prompt) => prompt.manifest)).toBe(true);
    const answered = prompts.at(-1)!.calls;
    const pull = runner.calls.findIndex((call) => call.args.includes("pull"));
    const up = runner.calls.findIndex((call) => call.args.includes("up"));
    expect(pull).toBeGreaterThanOrEqual(answered);
    expect(up).toBeGreaterThan(pull);
    expect(runner.calls.some((call) => call.args.includes("openteam-pi-auth"))).toBe(false);
    expect(readManifest(paths)?.ownerUsername).toBe("Raghav-P");
    const printed = output.join("\n");
    expect(printed).toContain("OpenTeam is ready");
    expect(printed).toContain(
      "Next: open the OpenTeam app and sign in with this server and username."
    );
    expect(printed).toContain("https://openteam.so/download");
    expect(printed).toContain("https://testflight.apple.com/join/KFBFPkjP");
    expect(printed).toContain("The app will help you connect a model and create your first bot.");
    expect(printed).not.toContain("Inference");
  });
});

describe("interrupted first install", () => {
  test("a first install that cannot save its files leaves none behind, so it can be retried", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-partial-install-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(join(directory, "installation"));
    const original = config.writeFileAtomic;
    const write = spyOn(config, "writeFileAtomic").mockImplementation((path, contents, mode) => {
      if (path === paths.environment) throw new Error("ENOSPC: no space left on device, write");
      original(path, contents, mode);
    });
    const prompter: SetupPrompter = {
      question: async () => "",
      secret: async () => "",
      close() {},
    };
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const output = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        installCommand(
          paths,
          parseArguments(["install", ...releaseFixture()]),
          new HealthyDockerRunner(),
          prompter
        )
      ).rejects.toThrow(
        `Could not save the OpenTeam configuration in ${paths.directory}: ENOSPC: no space left on device, write.`
      );
    } finally {
      write.mockRestore();
      log.mockRestore();
      output.mockRestore();
    }

    for (const file of [paths.compose, paths.environment, paths.manifest]) {
      expect(existsSync(file)).toBe(false);
    }
    const diagnosis = await runDoctor(paths, new HealthyDockerRunner(), "openteam", {
      checkInstallPorts: false,
    });
    expect(diagnosis.checks.find((check) => check.label === "Installation")?.level).toBe("warn");
  });
});

describe("installed lifecycle", () => {
  test("reinstall refreshes release images while preserving account, environment and data", async () => {
    const { paths } = fixture();
    const manifest = readManifest(paths)!;
    const environment = readFileSync(paths.environment, "utf8");
    writeFileAtomic(paths.compose, "old local image configuration");
    writeManifest(paths, { ...manifest, uninstalledAt: new Date().toISOString() });
    await installCommand(
      paths,
      parseArguments(["install", ...releaseFixture()]),
      new HealthyDockerRunner()
    );
    expect(readFileSync(paths.compose, "utf8")).toContain("example/openteam-server");
    expect(readFileSync(paths.environment, "utf8")).toBe(environment);
    expect(readManifest(paths)?.ownerUsername).toBe(manifest.ownerUsername);
    expect(readManifest(paths)?.uninstalledAt).toBeUndefined();
  });

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
      expect(output.join("\n").includes("No model is connected yet")).toBe(inference === "missing");
      if (inference === "missing")
        expect(output.join(" ").replace(/\s+/g, " ")).toContain(
          "Connect one in the OpenTeam app under Settings → Server, or run openteam model"
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
    expect(output.filter((line) => line.includes("Checking startup ports…"))).toHaveLength(2);
    const summaries = output.filter((line) => line.includes("ALREADY RUNNING"));
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary).toContain("OpenTeam is already running");
      expect(summary).toContain("http://127.0.0.1:");
      expect(summary).toContain("Network address");
      expect(summary).toContain("http://100.64.0.5:8787");
    }
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
      detail: "status is missing; connect a model before starting a task",
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

  test("status reports a missing worker even when the API is healthy, without starting services", async () => {
    const { paths } = fixture("ready");
    const runner = new HealthyDockerRunner();
    runner.running = ["postgres", "server", "computer"];
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    try {
      await expect(statusCommand(paths, runner)).rejects.toMatchObject({
        exitCode: 2,
        reported: true,
      });
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("NEEDS ATTENTION");
    expect(output.join("\n")).toContain("Not created");
    expect(
      runner.calls.some((call) => call.args.includes("up") || call.args.includes("start"))
    ).toBe(false);
    expect(runner.calls.filter((call) => call.args.includes("ps"))).toHaveLength(1);
  });

  test("safe uninstall removes containers but preserves configuration", async () => {
    const { directory, paths } = fixture();
    const runner = new HealthyDockerRunner();
    let removedCli = false;
    await uninstallCommand(paths, parseArguments(["uninstall", "--yes"]), runner, {
      removeCli: () => {
        removedCli = true;
        return "/usr/local/bin/openteam";
      },
    });
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENTEAM_CONTROL_TOKEN=");
    expect(readManifest(paths)?.uninstalledAt).toBeString();
    expect(removedCli).toBe(true);
    expect(directory).toBe(paths.directory);
    expect(runner.calls.at(-1)?.args).toContain("down");
    expect(runner.calls.at(-1)?.args).not.toContain("--volumes");
  });

  test("purge requires an explicit flag and removes the installation directory", async () => {
    const { directory, paths } = fixture();
    const runner = new HealthyDockerRunner();
    let removedCli = false;
    await uninstallCommand(paths, parseArguments(["uninstall", "--purge", "--yes"]), runner, {
      removeCli: () => {
        removedCli = true;
        return "/usr/local/bin/openteam";
      },
    });
    expect(readManifest(paths)).toBeNull();
    expect(removedCli).toBe(true);
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

  test("a successful update keeps the newest three update backups and logs what it removed", async () => {
    const { paths } = fixture();
    const old = [
      "postgres-1.1.0-before-1.2.0-2026-01-01T00-00-00-000Z.sql",
      "postgres-1.2.0-before-1.2.1-2026-02-01T00-00-00-000Z.sql",
      "postgres-1.2.1-before-1.2.2-2026-03-01T00-00-00-000Z.sql",
      "postgres-1.2.2-before-1.2.3-2026-04-01T00-00-00-000Z.sql",
    ];
    mkdirSync(paths.backups, { recursive: true });
    for (const name of old) writeFileSync(join(paths.backups, name), "SELECT 1;\n");
    const messages: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      messages.push(values.map(String).join(" "));
    });
    try {
      await updateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", ...releaseFixture()]),
        new HealthyDockerRunner()
      );
    } finally {
      log.mockRestore();
    }
    const current = readUpdateState(paths)!.backupPath!;
    expect(readdirSync(paths.backups).sort()).toEqual(
      [old[2]!, old[3]!, basename(current)].sort()
    );
    expect(messages).toContain(
      `Removed 2 older update backups from ${paths.backups}: ${old[1]}, ${old[0]}`
    );
  });

  test("a failed update deletes no backups", async () => {
    const { paths } = fixture();
    const old = [1, 2, 3, 4].map(
      (month) => `postgres-1.2.2-before-1.2.3-2026-0${month}-01T00-00-00-000Z.sql`
    );
    mkdirSync(paths.backups, { recursive: true });
    for (const name of old) writeFileSync(join(paths.backups, name), "SELECT 1;\n");
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", ...releaseFixture()]),
          new HealthyDockerRunner(false, true)
        )
      ).rejects.toThrow("Update failed");
    } finally {
      log.mockRestore();
    }
    expect(readdirSync(paths.backups)).toHaveLength(5);
  });

  test("--when-idle refuses while a bot is working, before it downloads or stops anything", async () => {
    let authorization: string | null = null;
    const { paths } = fixture("missing", (request) => {
      authorization = request.headers.get("authorization");
      return Response.json({ bots: [{ botId: "b", name: "Chief of Staff", runIds: ["r"] }] });
    });
    const previousCompose = readFileSync(paths.compose, "utf8");
    const runner = new HealthyDockerRunner();
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", "--when-idle", ...releaseFixture()]),
          runner
        )
      ).rejects.toThrow(UPDATE_BUSY_MESSAGE);
    } finally {
      log.mockRestore();
    }
    const token = parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_CONTROL_TOKEN");
    expect(String(authorization)).toBe(`Bearer ${token}`);
    expect(runner.calls.some((call) => call.args.includes("pull"))).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("stop"))).toBe(false);
    expect(readFileSync(paths.compose, "utf8")).toBe(previousCompose);
    expect(readManifest(paths)?.version).toBe("1.2.3");
  });

  test("--when-idle checks again after the download and stops nothing if a bot started working", async () => {
    let checks = 0;
    const { paths } = fixture("missing", () =>
      Response.json({ bots: ++checks > 1 ? [{ botId: "b", name: "Scout", runIds: [] }] : [] })
    );
    const previousCompose = readFileSync(paths.compose, "utf8");
    const runner = new HealthyDockerRunner();
    const messages: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      messages.push(values.map(String).join(" "));
    });
    try {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", "--when-idle", "--json-progress", ...releaseFixture()]),
          runner
        )
      ).rejects.toThrow(UPDATE_BUSY_MESSAGE);
    } finally {
      log.mockRestore();
    }
    expect(checks).toBe(2);
    expect(runner.calls.some((call) => call.args.includes("pull"))).toBe(true);
    expect(runner.calls.some((call) => call.args.includes("stop"))).toBe(false);
    expect(messages.some((message) => message.includes('"phase":"rolling-back"'))).toBe(false);
    expect(messages).toContain("Still working: Scout");
    expect(existsSync(`${paths.compose}.next`)).toBe(false);
    expect(readFileSync(paths.compose, "utf8")).toBe(previousCompose);
  });

  test("--when-idle updates once every bot is done", async () => {
    const { paths } = fixture("missing", () => Response.json({ bots: [] }));
    const runner = new HealthyDockerRunner();
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await updateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", "--when-idle", ...releaseFixture()]),
        runner
      );
    } finally {
      log.mockRestore();
    }
    expect(readManifest(paths)?.version).toBe("1.3.0");
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

  test("points a silent Docker failure at the durable update log", async () => {
    const { paths } = fixture();
    class SilentStartupFailure extends HealthyDockerRunner {
      override run(command: string, args: readonly string[], options?: RunOptions): RunResult {
        const result = super.run(command, args, options);
        return result.stderr === "fixture startup failed" ? { ...result, stderr: "" } : result;
      }
    }
    const error = await updateCommand(
      paths,
      parseArguments(["update", "--version", "1.3.0", ...releaseFixture()]),
      new SilentStartupFailure(false, true)
    ).then(
      () => null,
      (caught: unknown) => caught as Error
    );

    expect(error?.message).toContain(
      `Docker Compose failed: command failed; see ${paths.updateLog}`
    );
    expect(error?.message).not.toContain("see the Docker output above");
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
