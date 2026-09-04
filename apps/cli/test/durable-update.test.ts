import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import { installationPaths, writeManifest } from "../src/config";
import {
  CLI_UPDATE_FOLLOWER_PID_ENV,
  CLI_UPDATE_SOURCE_ENV,
  CLI_UPDATE_TARGET_ENV,
  CLI_UPDATE_VERSION_ENV,
} from "../src/cli-update";
import {
  durableUpdateCommand,
  runUpdateWorker,
  UPDATE_WORKER_JOB_ENV,
  updateWorkerArguments,
  updateWorkerJobId,
} from "../src/durable-update";
import { readUpdateState, writeUpdateState } from "../src/update-safety";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-durable-update-"));
  temporaryDirectories.push(directory);
  return installationPaths(directory);
};

const state = (jobId: string, status: "running" | "complete", phase: "checking" | "complete") => ({
  schemaVersion: 1 as const,
  jobId,
  status,
  phase,
  fromVersion: "1.2.3",
  targetVersion: "1.3.0",
  message: phase === "complete" ? "OpenTeam is now running 1.3.0" : "Checking this server",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("durable one-command update", () => {
  test("relaunches the same CLI command under Node, Electron-as-Node, and a compiled binary", () => {
    expect(
      updateWorkerArguments(
        ["/usr/bin/node", "/app/openteam.js", "update", "--version", "1.3.0"],
        "/usr/bin/node"
      )
    ).toEqual(["/app/openteam.js", "update", "--version", "1.3.0"]);
    expect(
      updateWorkerArguments(
        ["/Applications/OpenTeam", "/resources/openteam-cli.js", "update"],
        "/Applications/OpenTeam"
      )
    ).toEqual(["/resources/openteam-cli.js", "update"]);
    expect(
      updateWorkerArguments(
        ["/usr/local/bin/openteam", "/usr/local/bin/openteam", "update"],
        "/usr/local/bin/openteam"
      )
    ).toEqual(["update"]);
    expect(
      updateWorkerArguments(
        ["/usr/local/bin/openteam", "/$bunfs/root/openteam", "update"],
        "/usr/local/bin/openteam",
        true
      )
    ).toEqual(["update"]);
  });

  test("accepts only a generated worker job id", () => {
    const jobId = randomUUID();
    expect(updateWorkerJobId({ [UPDATE_WORKER_JOB_ENV]: jobId })).toBe(jobId);
    expect(updateWorkerJobId({ [UPDATE_WORKER_JOB_ENV]: "not-a-job" })).toBeNull();
  });

  test("uses one visible command, detaches the worker, and follows persisted progress", async () => {
    const paths = fixture();
    const messages: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => messages.push(String(value)));
    let spawnedArguments: readonly string[] = [];
    let detached = false;
    let unrefCalled = false;
    try {
      await durableUpdateCommand(
        paths,
        parseArguments(["update", "--version", "1.3.0", "--json-progress"]),
        {
          executable: "/usr/bin/node",
          argv: ["/usr/bin/node", "/app/openteam.js", "update", "--version", "1.3.0"],
          spawnWorker: (_executable, args, options) => {
            spawnedArguments = args;
            detached = options.detached;
            const jobId = options.env[UPDATE_WORKER_JOB_ENV];
            if (!jobId) throw new Error("worker job id missing");
            setTimeout(() => {
              writeUpdateState(paths, state(jobId, "running", "checking"));
              writeUpdateState(paths, state(jobId, "complete", "complete"));
            }, 0);
            return {
              pid: process.pid,
              unref: () => {
                unrefCalled = true;
              },
            };
          },
        }
      );
    } finally {
      log.mockRestore();
    }

    expect(spawnedArguments).toEqual(["/app/openteam.js", "update", "--version", "1.3.0"]);
    expect(detached).toBe(true);
    expect(unrefCalled).toBe(true);
    expect(messages.some((message) => message.includes('"safeToCloseDesktop":true'))).toBe(true);
    expect(messages.some((message) => message.includes('"phase":"complete"'))).toBe(true);
  });

  test("reattaches to an active matching job instead of starting another worker", async () => {
    const paths = fixture();
    const jobId = randomUUID();
    mkdirSync(paths.updateLock, { mode: 0o700 });
    writeFileSync(
      join(paths.updateLock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
    writeUpdateState(paths, state(jobId, "running", "checking"));
    setTimeout(() => writeUpdateState(paths, state(jobId, "complete", "complete")), 0);
    let spawned = false;
    await durableUpdateCommand(paths, parseArguments(["update", "--version", "1.3.0"]), {
      spawnWorker: () => {
        spawned = true;
        return { unref() {} };
      },
    });
    expect(spawned).toBe(false);
  });

  test("runs a standalone upgrade through the staged target CLI", async () => {
    const paths = fixture();
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openteam-compose.yaml",
      installedAt: now,
      updatedAt: now,
    });
    const installed = "/usr/local/bin/openteam";
    const candidate = "/usr/local/bin/.openteam.update-1.3.0-test";
    let launchedExecutable = "";
    let launchedArguments: readonly string[] = [];
    let launchedEnvironment: NodeJS.ProcessEnv = {};
    const jobId = randomUUID();
    await runUpdateWorker(
      paths,
      parseArguments(["update", "--version", "1.3.0"]),
      {
        run: () => ({
          status: 1,
          stdout: "",
          stderr: "unexpected runner call",
        }),
      },
      jobId,
      {
        executable: installed,
        argv: [installed, installed, "update", "--version", "1.3.0"],
        platform: "darwin",
        architecture: "arm64",
        versions: { bun: "1.3.8" },
        standaloneExecutable: true,
        environment: { [CLI_UPDATE_FOLLOWER_PID_ENV]: "321" },
        stageCli: async () => ({
          source: candidate,
          target: installed,
          version: "1.3.0",
        }),
        spawnHandoff: (executable, args, options) => {
          launchedExecutable = executable;
          launchedArguments = args;
          launchedEnvironment = options.env;
          return { pid: process.pid, unref() {} };
        },
      }
    );

    expect(launchedExecutable).toBe(candidate);
    expect(launchedArguments).toEqual(["update", "--version", "1.3.0"]);
    expect(launchedEnvironment[CLI_UPDATE_SOURCE_ENV]).toBe(candidate);
    expect(launchedEnvironment[CLI_UPDATE_TARGET_ENV]).toBe(installed);
    expect(launchedEnvironment[CLI_UPDATE_VERSION_ENV]).toBe("1.3.0");
    expect(launchedEnvironment[CLI_UPDATE_FOLLOWER_PID_ENV]).toBe("321");
    expect(readUpdateState(paths)).toMatchObject({
      jobId,
      workerPid: process.pid,
      status: "running",
      phase: "updating-cli",
      targetVersion: "1.3.0",
    });
  });

  test("records a failed CLI bootstrap before any server command can run", async () => {
    const paths = fixture();
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openteam-compose.yaml",
      installedAt: now,
      updatedAt: now,
    });
    let serverCommandRan = false;
    const installed = "/usr/local/bin/openteam";
    const jobId = randomUUID();
    await expect(
      runUpdateWorker(
        paths,
        parseArguments(["update", "--version", "1.3.0"]),
        {
          run: () => {
            serverCommandRan = true;
            return { status: 1, stdout: "", stderr: "unexpected runner call" };
          },
        },
        jobId,
        {
          executable: installed,
          argv: [installed, installed, "update", "--version", "1.3.0"],
          platform: "darwin",
          architecture: "arm64",
          versions: { bun: "1.3.8" },
          standaloneExecutable: true,
          stageCli: async () => {
            throw new Error("fixture signature rejected");
          },
        }
      )
    ).rejects.toThrow("fixture signature rejected");
    expect(serverCommandRan).toBe(false);
    expect(readUpdateState(paths)).toMatchObject({
      jobId,
      status: "error",
      phase: "error",
      message: "fixture signature rejected",
    });
  });
});
