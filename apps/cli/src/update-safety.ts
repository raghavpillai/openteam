import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { InstallationPaths } from "./config";
import { ensureDirectory, writeFileAtomic } from "./config";
import { MINIMUM_UPDATE_DISK_BYTES } from "./constants";
import type { ComposeProject } from "./docker";
import { dockerDaemon } from "./docker";
import { CliError } from "./errors";
import type { CommandRunner } from "./process";

export type PersistedUpdatePhase =
  | "checking"
  | "downloading"
  | "backing-up"
  | "pulling"
  | "restarting"
  | "verifying"
  | "rolling-back"
  | "complete"
  | "error";

export interface PersistedUpdateState {
  schemaVersion: 1;
  jobId: string;
  sequence?: number;
  workerPid?: number;
  status: "running" | "complete" | "error";
  phase: PersistedUpdatePhase;
  fromVersion: string;
  targetVersion: string | null;
  message: string;
  startedAt: string;
  updatedAt: string;
  backupPath?: string;
}

export const writeUpdateState = (
  paths: InstallationPaths,
  state: PersistedUpdateState
): PersistedUpdateState => {
  const previous = readUpdateState(paths);
  const sameJob = previous?.jobId === state.jobId;
  const next = {
    ...state,
    sequence: sameJob ? (previous.sequence ?? -1) + 1 : (state.sequence ?? 0),
    updatedAt: new Date().toISOString(),
  };
  const event = `${JSON.stringify(next)}\n`;
  if (sameJob && existsSync(paths.updateEvents)) {
    appendFileSync(paths.updateEvents, event, { encoding: "utf8", mode: 0o600, flush: true });
  } else {
    writeFileAtomic(paths.updateEvents, event, 0o600);
  }
  writeFileAtomic(paths.updateState, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
};

export const readUpdateState = (paths: InstallationPaths): PersistedUpdateState | null => {
  if (!existsSync(paths.updateState)) return null;
  try {
    const state = JSON.parse(readFileSync(paths.updateState, "utf8")) as PersistedUpdateState;
    return state.schemaVersion === 1 && typeof state.jobId === "string" ? state : null;
  } catch {
    return null;
  }
};

export const readUpdateEvents = (
  paths: InstallationPaths,
  jobId: string,
  afterSequence = -1
): PersistedUpdateState[] => {
  if (!existsSync(paths.updateEvents)) return [];
  try {
    return readFileSync(paths.updateEvents, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const state = JSON.parse(line) as PersistedUpdateState;
          return state.schemaVersion === 1 &&
            state.jobId === jobId &&
            Number.isSafeInteger(state.sequence) &&
            (state.sequence ?? -1) > afterSequence
            ? [state]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const activeUpdateProcess = (paths: InstallationPaths): number | null => {
  const ownerPath = join(paths.updateLock, "owner.json");
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && processIsAlive(owner.pid) ? owner.pid : null;
  } catch {
    return null;
  }
};

export const acquireUpdateLock = (paths: InstallationPaths): (() => void) => {
  ensureDirectory(paths.directory);
  const ownerPath = join(paths.updateLock, "owner.json");
  const claim = () => {
    mkdirSync(paths.updateLock, { mode: 0o700 });
    writeFileSync(
      ownerPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid?: unknown } | null = null;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
    } catch {
      owner = null;
    }
    if (typeof owner?.pid === "number" && processIsAlive(owner.pid)) {
      throw new CliError(`Another OpenTeam update is already running (process ${owner.pid}).`);
    }
    rmSync(paths.updateLock, { recursive: true, force: true });
    claim();
  }
  return () => rmSync(paths.updateLock, { recursive: true, force: true });
};

export const assertUpdatePreflight = (
  paths: InstallationPaths,
  runner: CommandRunner,
  project: ComposeProject,
  composeFile: string
): void => {
  const filesystem = statfsSync(paths.directory);
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (available < MINIMUM_UPDATE_DISK_BYTES) {
    throw new CliError(
      `OpenTeam needs at least 4 GiB free to update safely; only ${(available / 1024 ** 3).toFixed(1)} GiB is available.`
    );
  }
  const daemon = dockerDaemon(runner);
  if (daemon.status !== 0) throw new CliError("The Docker daemon is not reachable.");
  project.runOrThrow(["config", "--quiet"], { composeFile });
};

export const createDatabaseBackup = (
  paths: InstallationPaths,
  project: ComposeProject,
  fromVersion: string,
  targetVersion: string
): string => {
  ensureDirectory(paths.backups);
  if (process.platform !== "win32") chmodSync(paths.backups, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(
    paths.backups,
    `postgres-${fromVersion}-before-${targetVersion}-${timestamp}.sql`
  );
  const result = project.run(
    [
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "openteam",
      "-d",
      "openteam",
      "--format=plain",
      "--no-owner",
      "--no-privileges",
    ],
    { outputFile: destination }
  );
  if (result.status !== 0 || !existsSync(destination) || statSync(destination).size === 0) {
    rmSync(destination, { force: true });
    throw new CliError(
      `Could not create the pre-update database backup: ${result.stderr.trim() || "pg_dump failed"}`
    );
  }
  return destination;
};

export const restoreDatabaseBackup = (project: ComposeProject, backupPath: string): void => {
  if (!existsSync(backupPath) || statSync(backupPath).size === 0) {
    throw new CliError(`Database rollback backup is missing or empty: ${backupPath}`);
  }
  project.runOrThrow(["up", "--detach", "--wait", "--wait-timeout", "120", "postgres"]);
  project.runOrThrow([
    "exec",
    "-T",
    "postgres",
    "dropdb",
    "-U",
    "openteam",
    "--force",
    "--if-exists",
    "openteam",
  ]);
  project.runOrThrow(["exec", "-T", "postgres", "createdb", "-U", "openteam", "openteam"]);
  project.runOrThrow(
    ["exec", "-T", "postgres", "psql", "-U", "openteam", "-d", "openteam", "-v", "ON_ERROR_STOP=1"],
    { inputFile: backupPath }
  );
};
