import { spawn } from "node:child_process";
import { constants, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerUpdateHeartbeat, ServerUpdateRequest } from "@openteam/contracts";
import {
  compareOpenTeamVersions,
  normalizeOpenTeamVersion,
} from "@openteam/contracts/version-compatibility";
import { type InstallationPaths, parseEnvironment, readManifest, writeFileAtomic } from "./config";
import { updateWorkerArguments } from "./durable-update";
import { healthUrl } from "./health";
import { activeUpdateProcess, readUpdateState } from "./update-safety";
import { isBunStandaloneExecutable, readCliPromotion } from "./cli-update";
import { CLI_VERSION } from "./constants";

export const UPDATE_AGENT_ENV = "OPENTEAM_UPDATE_AGENT";
export const UPDATE_AGENT_CLI_ENV = "OPENTEAM_UPDATE_AGENT_CLI";
export const updateAgentExecutable = (
  environment = process.env,
  executable = process.execPath
): string =>
  readCliPromotion(environment, executable, CLI_VERSION)?.target ??
  environment[UPDATE_AGENT_CLI_ENV] ??
  executable;
const interval = 2_000;
const workerEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of [
    UPDATE_AGENT_ENV,
    UPDATE_AGENT_CLI_ENV,
    "OPENTEAM_UPDATE_WORKER_JOB",
    "OPENTEAM_CLI_UPDATE_SOURCE",
    "OPENTEAM_CLI_UPDATE_TARGET",
    "OPENTEAM_CLI_UPDATE_VERSION",
    "OPENTEAM_CLI_UPDATE_FOLLOWER_PID",
  ])
    delete environment[name];
  return environment;
};
// Bun's Node compatibility declarations omit these EventEmitter overloads.
const events = (child: ReturnType<typeof spawn>) =>
  child as unknown as {
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "exit", listener: () => void): void;
  };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lockPath = (paths: InstallationPaths) => join(paths.directory, "update-agent.lock");
const lockOwner = (paths: InstallationPaths): number | null => {
  try {
    return Number(readFileSync(join(lockPath(paths), "pid"), "utf8")) || null;
  } catch {
    return null;
  }
};

/** No new listener, network port, or desktop credentials: the host polls its own installation. */
export const ensureUpdateAgent = (paths: InstallationPaths): void => {
  if (!readManifest(paths)?.ownerUsername) return;
  const owner = lockOwner(paths);
  if (owner && alive(owner)) return;
  const args = updateWorkerArguments([
    process.argv[0]!,
    process.argv[1]!,
    "status",
    "--dir",
    paths.directory,
  ]);
  const installedExecutable = updateAgentExecutable();
  let executable = installedExecutable;
  // A persistent Windows daemon must not hold the installed CLI's executable open
  // while a later update promotes its replacement.
  if (process.platform === "win32" && isBunStandaloneExecutable()) {
    executable = join(paths.directory, `update-agent-${CLI_VERSION}.exe`);
    try {
      copyFileSync(installedExecutable, executable, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...workerEnvironment(),
      [UPDATE_AGENT_ENV]: "1",
      [UPDATE_AGENT_CLI_ENV]: installedExecutable,
    },
  });
  events(child).on("error", (error) =>
    console.warn(`Server updates could not be enabled: ${error.message}`)
  );
  child.unref();
};

export const updateAgentArguments = (
  paths: InstallationPaths,
  request: ServerUpdateRequest
): string[] => {
  const current = readManifest(paths)?.version;
  const version = normalizeOpenTeamVersion(request.targetVersion);
  if (
    !current ||
    !version ||
    version.includes("-") ||
    (compareOpenTeamVersions(version, current) ?? 0) <= 0
  )
    throw new Error("The server requested an invalid update version.");
  return updateWorkerArguments([
    process.argv[0]!,
    process.argv[1]!,
    "update",
    "--dir",
    paths.directory,
    "--version",
    version,
    "--json-progress",
  ]);
};

interface AcceptedUpdate {
  id: string;
  baselineJob: string | null;
  error?: string;
}

export class UpdateAgent {
  private accepted: AcceptedUpdate | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private readonly journal: string;

  constructor(
    private readonly paths: InstallationPaths,
    private readonly request = fetch,
    private readonly launch: typeof spawn = spawn
  ) {
    this.journal = join(paths.directory, "update-agent-request.json");
    try {
      this.accepted = JSON.parse(readFileSync(this.journal, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save() {
    writeFileAtomic(this.journal, JSON.stringify(this.accepted), 0o600);
  }

  async tick(): Promise<void> {
    const environment = parseEnvironment(readFileSync(this.paths.environment, "utf8"));
    const token = environment.get("OPENTEAM_CONTROL_TOKEN");
    if (!token) throw new Error("Installation control token is missing.");
    const progress = readUpdateState(this.paths);
    const accepted = this.accepted;
    let report: ServerUpdateHeartbeat = {};
    if (accepted) {
      const matching = progress && progress.jobId !== accepted.baselineJob;
      report = matching
        ? {
            requestId: accepted.id,
            status: progress.status === "running" ? "running" : progress.status,
            phase: progress.phase,
            message: progress.message,
            jobId: progress.jobId,
          }
        : {
            requestId: accepted.id,
            status: "running",
            phase: "checking",
            message: "Starting the server updater…",
          };
      if (
        accepted.error ||
        (!this.child &&
          (!matching || (progress.status === "running" && !activeUpdateProcess(this.paths))))
      ) {
        report = {
          requestId: accepted.id,
          status: "error",
          phase: "error",
          message: accepted.error ?? "The server updater stopped. Retry the update.",
        };
      }
    }
    const response = await this.request(
      new URL("/api/v0/internal/system/update-agent", healthUrl(this.paths)),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!response.ok) throw new Error(`Update agent: HTTP ${response.status}`);
    const { request } = (await response.json()) as { request: ServerUpdateRequest | null };
    if (!request || !["queued", "running"].includes(request.status) || request.id === accepted?.id)
      return;
    if (this.child || activeUpdateProcess(this.paths)) return;
    // Persist before spawning so a daemon restart cannot execute a request twice.
    this.accepted = { id: request.id, baselineJob: progress?.jobId ?? null };
    this.save();
    try {
      this.child = this.launch(updateAgentExecutable(), updateAgentArguments(this.paths, request), {
        stdio: "ignore",
        windowsHide: true,
        env: { ...workerEnvironment(), OPENTEAM_UPDATE_WHEN_IDLE: "1" },
      });
      events(this.child).on("error", (error) => {
        this.accepted!.error = error.message;
        this.save();
        this.child = null;
      });
      events(this.child).on("exit", () => {
        this.child = null;
      });
    } catch (error) {
      this.accepted.error = error instanceof Error ? error.message : String(error);
      this.save();
      this.child = null;
    }
  }
}

export const runUpdateAgent = async (paths: InstallationPaths): Promise<void> => {
  const owner = lockOwner(paths);
  if (owner && alive(owner)) return;
  // An incomplete claim is another daemon starting; leave it time to write its PID.
  if (!owner) {
    try {
      mkdirSync(lockPath(paths), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
  } else {
    rmSync(lockPath(paths), { recursive: true, force: true });
    try {
      mkdirSync(lockPath(paths), { mode: 0o700 });
    } catch {
      return;
    }
  }
  writeFileSync(join(lockPath(paths), "pid"), String(process.pid), { mode: 0o600 });
  try {
    const agent = new UpdateAgent(paths);
    while (true) {
      const manifest = readManifest(paths);
      if (!manifest || manifest.uninstalledAt) return;
      await agent.tick().catch(() => undefined); // Reconnect through server restarts and rollback.
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } finally {
    if (lockOwner(paths) === process.pid) rmSync(lockPath(paths), { recursive: true, force: true });
  }
};
