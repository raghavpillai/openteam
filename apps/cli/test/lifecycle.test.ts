import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import * as config from "../src/config";
import * as ports from "../src/ports";
import {
  installCommand,
  startCommand,
  uninstallCommand,
  updateCommand,
  UPDATE_PROGRESS_PREFIX,
} from "../src/lifecycle";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import type { SetupPrompter } from "../src/setup";
import { updateBusyMessage } from "@openteam/contracts/server-updates";
import { readUpdateState } from "../src/update-safety";

class HealthyDockerRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: RunOptions;
  }> = [];
  imageTags = new Map<string, Set<string>>();
  running = ["postgres", "server", "worker", "computer"];
  serviceHealth: Record<string, string> = {};
  extraStates: Array<{
    Service: string;
    State: string;
    Health?: string;
    ExitCode?: number;
  }> = [];
  stateFormat: "array" | "lines" = "lines";
  onStart?: () => void;
  private failedStart = false;

  constructor(private readonly failFirstStart = false) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (args.includes("config") && args.includes("--format")) {
      const version = parseEnvironment(readFileSync(join(options!.cwd!, ".env"), "utf8")).get(
        "OPENTEAM_VERSION"
      );
      return {
        status: 0,
        stdout: JSON.stringify({
          services: { server: { image: `fixture:${version}` } },
        }),
        stderr: "",
      };
    }
    if (args[0] === "container" && args[1] === "ls") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2]!;
      const id = ref.startsWith("fixture:")
        ? `sha256:${Buffer.from(ref).toString("hex").padEnd(64, "0")}`
        : [...this.imageTags].find(([, tags]) => tags.has(ref))?.[0];
      return {
        status: 0,
        stdout: JSON.stringify([{ Id: id, RepoTags: [...(this.imageTags.get(id!) ?? [])] }]),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "tag") {
      const tags = this.imageTags.get(args[2]!) ?? new Set<string>();
      tags.add(args[3]!);
      this.imageTags.set(args[2]!, tags);
    }
    if (command === "tailscale") return { status: 0, stdout: "{}", stderr: "" };
    if (args.includes("exec") && args.includes("-e")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "docker" && args[0] === "--version") {
      return { status: 0, stdout: "Docker version 29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "info") {
      return { status: 0, stdout: "29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return {
        status: 0,
        stdout: "Docker Compose version v2.30.0",
        stderr: "",
      };
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
        stdout:
          this.stateFormat === "array"
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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openteam-cli-lifecycle-")));
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
      prompts.push({
        prompt,
        calls: runner.calls.length,
        manifest: existsSync(paths.manifest),
      });
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

describe("installed lifecycle", () => {
  test("reinstall refreshes release images while preserving account, environment and data", async () => {
    const { paths } = fixture();
    const manifest = readManifest(paths)!;
    const environment = readFileSync(paths.environment, "utf8");
    writeFileAtomic(paths.compose, "old local image configuration");
    writeManifest(paths, {
      ...manifest,
      uninstalledAt: new Date().toISOString(),
    });
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

  test("does not skip startup for missing or unhealthy services or failed setup jobs", async () => {
    for (const scenario of ["missing-worker", "unhealthy", "failed-job", "wrong-version"]) {
      const { paths } = fixture();
      const runner = new HealthyDockerRunner();
      if (scenario === "missing-worker") runner.running = ["server", "postgres", "computer"];
      else if (scenario === "unhealthy") runner.serviceHealth.worker = "unhealthy";
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

  test("--when-idle refuses while a bot is working, before it downloads or stops anything", async () => {
    let authorization: string | null = null;
    const { paths } = fixture("missing", (request) => {
      authorization = request.headers.get("authorization");
      return Response.json({
        bots: [{ botId: "b", name: "Chief of Staff", runIds: ["r"] }],
      });
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
      ).rejects.toThrow(updateBusyMessage(["Chief of Staff"]));
    } finally {
      log.mockRestore();
    }
    const token = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
      "OPENTEAM_CONTROL_TOKEN"
    );
    expect(String(authorization)).toBe(`Bearer ${token}`);
    expect(runner.calls.some((call) => call.args.includes("pull"))).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("stop"))).toBe(false);
    expect(readFileSync(paths.compose, "utf8")).toBe(previousCompose);
    expect(readManifest(paths)?.version).toBe("1.2.3");
  });

  test("restores the database before restarting the prior release after startup fails, deleting no backups", async () => {
    const { paths } = fixture();
    mkdirSync(paths.backups, { recursive: true });
    for (const month of [1, 2, 3, 4])
      writeFileSync(
        join(paths.backups, `postgres-1.2.2-before-1.2.3-2026-0${month}-01T00-00-00-000Z.sql`),
        "SELECT 1;\n"
      );
    const runner = new HealthyDockerRunner(true);
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
    expect(readdirSync(paths.backups)).toHaveLength(5);
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
