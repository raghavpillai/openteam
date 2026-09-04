import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliOptions } from "./arguments";
import type { InstallationPaths } from "./config";
import { ensureDirectory, normalizeVersion } from "./config";
import { CliError } from "./errors";
import { UPDATE_PROGRESS_PREFIX } from "./lifecycle";
import {
  activeUpdateProcess,
  readUpdateEvents,
  readUpdateState,
  type PersistedUpdateState,
} from "./update-safety";

export const UPDATE_WORKER_JOB_ENV = "OPENTEAM_UPDATE_WORKER_JOB";
const WORKER_START_GRACE_MS = 10_000;
const FOLLOW_INTERVAL_MS = 150;
const MAX_LOG_ERROR_BYTES = 12_000;

type SpawnWorker = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    detached: true;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", number, number];
    windowsHide: true;
  }
) => { pid?: number; unref(): void };

interface DurableUpdateDependencies {
  spawnWorker?: SpawnWorker;
  executable?: string;
  argv?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const updateTargetMatches = (state: PersistedUpdateState, options: CliOptions): boolean =>
  !options.version ||
  !state.targetVersion ||
  normalizeVersion(options.version) === state.targetVersion;

const emitProgress = (options: CliOptions, state: PersistedUpdateState): void => {
  if (options.jsonProgress) {
    console.log(
      `${UPDATE_PROGRESS_PREFIX}${JSON.stringify({
        phase: state.phase,
        message: state.message,
        version: state.targetVersion ?? undefined,
        jobId: state.jobId,
        safeToCloseDesktop: true,
      })}`
    );
    return;
  }
  console.log(state.message);
};

export const reportActiveUpdate = (paths: InstallationPaths, options: CliOptions): boolean => {
  const state = readUpdateState(paths);
  if (state?.status !== "running") return false;
  emitProgress(options, state);
  return true;
};

const logFailure = (paths: InstallationPaths): string | null => {
  try {
    const contents = readFileSync(paths.updateLog, "utf8");
    const tail = contents.slice(-MAX_LOG_ERROR_BYTES).trim().split(/\r?\n/).at(-1);
    return tail?.replace(/^openteam:\s*/, "") || null;
  } catch {
    return null;
  }
};

export const updateWorkerJobId = (environment: NodeJS.ProcessEnv = process.env): string | null => {
  const value = environment[UPDATE_WORKER_JOB_ENV]?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
};

/** Reproduce the current CLI invocation for Node, Electron-as-Node, and Bun executables. */
export const updateWorkerArguments = (
  argv: readonly string[] = process.argv,
  executable = process.execPath
): string[] => {
  const entrypoint = argv[1];
  if (!entrypoint) return [];
  try {
    if (resolve(entrypoint) === resolve(executable)) return argv.slice(2);
  } catch {
    // Preserve the original invocation when either path is virtual (for example a bundled runtime).
  }
  return argv.slice(1);
};

export const followUpdateJob = async (
  paths: InstallationPaths,
  options: CliOptions,
  jobId: string,
  spawnedPid?: number
): Promise<void> => {
  const started = Date.now();
  let lastSequence = -1;
  let lastSignature = "";
  while (true) {
    const events = readUpdateEvents(paths, jobId, lastSequence);
    for (const event of events) {
      lastSequence = Math.max(lastSequence, event.sequence ?? lastSequence);
      const signature = `${event.phase}\0${event.message}\0${event.targetVersion ?? ""}`;
      if (signature !== lastSignature) {
        emitProgress(options, event);
        lastSignature = signature;
      }
    }

    const state = readUpdateState(paths);
    if (state?.jobId === jobId) {
      if ((state.sequence ?? -1) > lastSequence) {
        emitProgress(options, state);
        lastSequence = state.sequence ?? lastSequence;
      }
      if (state.status === "complete") return;
      if (state.status === "error") throw new CliError(state.message);
    }

    const activePid = activeUpdateProcess(paths);
    const spawnedIsAlive = spawnedPid ? processIsAlive(spawnedPid) : false;
    if (Date.now() - started >= WORKER_START_GRACE_MS && activePid === null && !spawnedIsAlive) {
      throw new CliError(
        logFailure(paths) ??
          "The durable update worker stopped unexpectedly. Run openteam update again to recover."
      );
    }
    await sleep(FOLLOW_INTERVAL_MS);
  }
};

export const durableUpdateCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  dependencies: DurableUpdateDependencies = {}
): Promise<void> => {
  const current = readUpdateState(paths);
  if (current?.status === "running" && activeUpdateProcess(paths) !== null) {
    if (!updateTargetMatches(current, options)) {
      throw new CliError(
        `OpenTeam is already updating to ${current.targetVersion ?? "the latest release"}.`
      );
    }
    await followUpdateJob(paths, options, current.jobId);
    return;
  }

  ensureDirectory(paths.directory);
  const jobId = randomUUID();
  const executable = dependencies.executable ?? process.execPath;
  const argv = dependencies.argv ?? process.argv;
  const environment = dependencies.environment ?? process.env;
  const log = openSync(paths.updateLog, "w", 0o600);
  let child;
  try {
    child = (dependencies.spawnWorker ?? (spawn as SpawnWorker))(
      executable,
      updateWorkerArguments(argv, executable),
      {
        cwd: paths.directory,
        detached: true,
        env: { ...environment, [UPDATE_WORKER_JOB_ENV]: jobId },
        stdio: ["ignore", log, log],
        windowsHide: true,
      }
    );
  } catch (error) {
    throw new CliError(
      `Could not start the durable update worker: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    closeSync(log);
  }
  child.unref();
  await followUpdateJob(paths, options, jobId, child.pid);
};
