import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
} from "../src/durable-update";
import {
  activeUpdateProcess,
  acquireUpdateLock,
  readUpdateEvents,
  readUpdateState,
  writeUpdateState,
} from "../src/update-safety";
import { scratch } from "./fixtures/harness";

const s = scratch();
const fixture = () => installationPaths(s.dir("openteam-update-"));

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
    expect(messages.every((message) => message.startsWith("@@OPENTEAM_UPDATE@@"))).toBe(true);
    expect(messages.some((message) => message.includes("\x1b"))).toBe(false);
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

describe("update transaction safety", () => {
  test("rejects concurrent updates and releases the installation lock", () => {
    const paths = fixture();
    const release = acquireUpdateLock(paths);
    expect(() => acquireUpdateLock(paths)).toThrow("already running");
    release();
    expect(existsSync(paths.updateLock)).toBe(false);
    const releaseAgain = acquireUpdateLock(paths);
    releaseAgain();
  });

  test("persists update jobs atomically for reconnecting clients", () => {
    const paths = fixture();
    const initial = writeUpdateState(paths, {
      schemaVersion: 1,
      jobId: "job-1",
      status: "running",
      phase: "pulling",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      message: "Pulling images",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(readUpdateState(paths)).toMatchObject({
      jobId: "job-1",
      status: "running",
      phase: "pulling",
      sequence: 0,
    });
    writeUpdateState(paths, {
      ...initial,
      phase: "complete",
      status: "complete",
      message: "Update complete",
    });
    expect(readUpdateEvents(paths, "job-1").map((event) => event.sequence)).toEqual([0, 1]);
  });

  test("treats the detached CLI bootstrap as active before it takes the server lock", () => {
    const paths = fixture();
    writeUpdateState(paths, {
      schemaVersion: 1,
      jobId: "job-1",
      workerPid: process.pid,
      status: "running",
      phase: "updating-cli",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      message: "Downloading command-line tools",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(activeUpdateProcess(paths)).toBe(process.pid);
  });
});
