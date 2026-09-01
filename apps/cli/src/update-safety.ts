import {
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
  const next = { ...state, updatedAt: new Date().toISOString() };
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

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
      throw new CliError(`Another OpenBot update is already running (process ${owner.pid}).`);
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
      `OpenBot needs at least 4 GiB free to update safely; only ${(available / 1024 ** 3).toFixed(1)} GiB is available.`
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
      "openbot",
      "-d",
      "openbot",
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
