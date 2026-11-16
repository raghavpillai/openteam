import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateBusyMessage } from "@openteam/contracts/server-updates";
import { parseArguments } from "../src/arguments";
import {
  type InstallationPaths,
  installationPaths,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import {
  installCommand,
  startCommand,
  UPDATE_PROGRESS_PREFIX,
  uninstallCommand,
  updateCommand,
} from "../src/lifecycle";
import type { RunOptions, RunResult } from "../src/process";
import type { SetupPrompter } from "../src/setup";
import { readUpdateState } from "../src/update-safety";
import {
  FakeDocker,
  installStack,
  ok,
  quietly,
  RELEASE_COMPOSE,
  scratch,
} from "./fixtures/harness";

/** A healthy stack whose image tags, `ps` states, and database dumps are simulated. */
class StackDocker extends FakeDocker {
  imageTags = new Map<string, Set<string>>();
  serviceHealth: Record<string, string> = {};
  extraStates: Array<{ Service: string; State: string; Health?: string; ExitCode?: number }> = [];
  stateFormat: "array" | "lines" = "lines";
  onStart?: () => void;

  constructor(private failFirstStart = false) {
    super();
  }

  protected override respond(
    _command: string,
    args: readonly string[],
    options?: RunOptions
  ): RunResult | undefined {
    if (args.includes("config") && args.includes("--format")) {
      const env = parseEnvironment(readFileSync(join(options!.cwd!, ".env"), "utf8"));
      return ok(
        JSON.stringify({
          services: { server: { image: `fixture:${env.get("OPENTEAM_VERSION")}` } },
        })
      );
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2]!;
      const id = ref.startsWith("fixture:")
        ? `sha256:${Buffer.from(ref).toString("hex").padEnd(64, "0")}`
        : [...this.imageTags].find(([, tags]) => tags.has(ref))?.[0];
      return ok(JSON.stringify([{ Id: id, RepoTags: [...(this.imageTags.get(id!) ?? [])] }]));
    }
    if (args[0] === "image" && args[1] === "tag") {
      const tags = this.imageTags.get(args[2]!) ?? new Set<string>();
      this.imageTags.set(args[2]!, tags.add(args[3]!));
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
      return ok(
        this.stateFormat === "array"
          ? JSON.stringify(states)
          : states.map((state) => JSON.stringify(state)).join("\n")
      );
    }
    if (args.includes("up")) {
      if (this.failFirstStart) {
        this.failFirstStart = false;
        return { status: 1, stdout: "", stderr: "fixture startup failed" };
      }
      this.onStart?.();
    }
    if (args.includes("pg_dump") && options?.outputFile)
      writeFileSync(options.outputFile, "-- OpenTeam test database backup\nSELECT 1;\n", {
        mode: 0o600,
      });
    return undefined;
  }
}

const s = scratch();

const versionOf = (paths: InstallationPaths) =>
  parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_VERSION");

/** An installed 1.2.3 stack whose health endpoint reports the configured version. */
const fixture = (activity?: (request: Request) => Response) => {
  const directory = s.dir("openteam-cli-lifecycle-");
  let paths!: InstallationPaths;
  const server = s.serve((request) => {
    if (activity && new URL(request.url).pathname === "/api/v0/internal/busy-bots")
      return activity(request);
    return Response.json({
      status: "ready",
      runtime: { inference: "missing" },
      release: { releaseVersion: versionOf(paths) },
    });
  });
  ({ paths } = installStack(directory, { apiPort: server.port }));
  return { directory, paths };
};

const releaseArguments = () => {
  const origin = s.release({ "openteam-compose.yaml": RELEASE_COMPOSE });
  return [
    "--compose-url",
    `${origin}/openteam-compose.yaml`,
    "--checksum-url",
    `${origin}/SHA256SUMS`,
    "--allow-unsigned",
  ];
};

describe("installed lifecycle", () => {
  test("reinstall refreshes release images while preserving account, environment and data", async () => {
    const { paths } = fixture();
    const manifest = readManifest(paths)!;
    const environment = readFileSync(paths.environment, "utf8");
    writeFileAtomic(paths.compose, "old local image configuration");
    writeManifest(paths, { ...manifest, uninstalledAt: new Date().toISOString() });
    await installCommand(
      paths,
      parseArguments(["install", ...releaseArguments()]),
      new StackDocker()
    );
    expect(readFileSync(paths.compose, "utf8")).toContain("example/openteam-server");
    expect(readFileSync(paths.environment, "utf8")).toBe(environment);
    expect(readManifest(paths)?.ownerUsername).toBe(manifest.ownerUsername);
    expect(readManifest(paths)?.uninstalledAt).toBeUndefined();
  });

  test("a cancelled first install keeps its manifest, so the next install resumes setup", async () => {
    const paths = installationPaths(join(s.dir("openteam-cli-resume-"), "installation"));
    let sessions = 0;
    const cancel: SetupPrompter = {
      question: async () => "",
      secret: async () => "",
      session: async () => (sessions++, null),
      close() {},
    };
    const install = (args: string[]) =>
      quietly(() => installCommand(paths, parseArguments(args), new StackDocker(), cancel));
    await install(["install", ...releaseArguments()]);
    expect(readManifest(paths)?.version).toBeString();
    const { lines } = await install(["install"]);
    expect(lines.join("\n")).toContain("setup is incomplete; resuming setup");
    expect(sessions).toBe(2);
    expect(readManifest(paths)?.ownerUsername).toBeUndefined();
  });

  test("repeated start checks preflight and reports already running without restarting services or setup jobs", async () => {
    const { paths } = fixture();
    const runner = new StackDocker();
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
    const { lines } = await quietly(async () => {
      await startCommand(paths, runner);
      runner.stateFormat = "array";
      await startCommand(paths, runner);
    });
    const summaries = lines.filter((line) => line.includes("ALREADY RUNNING"));
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) expect(summary).toContain("http://100.64.0.5:8787");
    expect(runner.index("up")).toBe(-1);
    expect(runner.index("-e")).toBe(-1);
  });

  // Missing and unhealthy services are covered by inspectStartupState in startup.test.ts.
  test("does not skip startup after a failed setup job or for another release", async () => {
    for (const scenario of ["failed-job", "wrong-version"]) {
      const { paths } = fixture();
      const runner = new StackDocker();
      if (scenario === "failed-job")
        runner.extraStates = [{ Service: "migrate", State: "exited", ExitCode: 1 }];
      else {
        writeManifest(paths, { ...readManifest(paths)!, version: "1.2.4" });
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
      await quietly(() => startCommand(paths, runner));
      expect(runner.count("up")).toBe(1);
    }
  });

  test("safe uninstall removes containers but preserves configuration", async () => {
    const { directory, paths } = fixture();
    const runner = new StackDocker();
    await uninstallCommand(paths, parseArguments(["uninstall", "--yes"]), runner, {
      removeCli: () => "/usr/local/bin/openteam",
    });
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(paths.environment, "utf8")).toContain("OPENTEAM_CONTROL_TOKEN=");
    expect(readManifest(paths)?.uninstalledAt).toBeString();
    expect(runner.calls.at(-1)?.args).toContain("down");
    expect(runner.calls.at(-1)?.args).not.toContain("--volumes");
  });

  test("updates the full Compose release and emits every desktop progress phase", async () => {
    const { paths } = fixture();
    const runner = new StackDocker();
    const { lines } = await quietly(() =>
      updateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", "--json-progress", ...releaseArguments()]),
        runner
      )
    );
    expect(readManifest(paths)?.version).toBe("1.3.0");
    expect(versionOf(paths)).toBe("1.3.0");
    expect(readUpdateState(paths)).toMatchObject({
      status: "complete",
      phase: "complete",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
    });
    expect(existsSync(readUpdateState(paths)?.backupPath ?? "")).toBe(true);
    const phases = lines
      .filter((line) => line.startsWith(UPDATE_PROGRESS_PREFIX))
      .map((line) => JSON.parse(line.slice(UPDATE_PROGRESS_PREFIX.length)).phase);
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
    const { paths } = fixture((request) => {
      authorization = request.headers.get("authorization");
      return Response.json({ bots: [{ botId: "b", name: "Chief of Staff", runIds: ["r"] }] });
    });
    const previousCompose = readFileSync(paths.compose, "utf8");
    const runner = new StackDocker();
    await quietly(async () => {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", "--when-idle", ...releaseArguments()]),
          runner
        )
      ).rejects.toThrow(updateBusyMessage(["Chief of Staff"]));
    });
    const token = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
      "OPENTEAM_CONTROL_TOKEN"
    );
    expect(String(authorization)).toBe(`Bearer ${token}`);
    expect(runner.index("pull")).toBe(-1);
    expect(runner.index("stop")).toBe(-1);
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
    const runner = new StackDocker(true);
    await quietly(async () => {
      await expect(
        updateCommand(
          paths,
          parseArguments(["update", "--version", "1.3.0", ...releaseArguments()]),
          runner
        )
      ).rejects.toThrow("previous Compose configuration was restored and restarted");
    });
    expect(runner.index("dropdb")).toBeGreaterThan(-1);
    const restoreIndex = runner.calls.findIndex((call) => Boolean(call.options?.inputFile));
    expect(restoreIndex).toBeGreaterThan(-1);
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
    const runner = new StackDocker();
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
