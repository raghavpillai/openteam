import { spawn, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
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
import {
  installUpdateAgentService,
  removeUpdateAgentService,
  type ServiceHost,
  systemServiceHost,
  type UpdateAgentCommand,
} from "./update-agent-service";

export const UPDATE_AGENT_ENV = "OPENTEAM_UPDATE_AGENT";
export const UPDATE_AGENT_CLI_ENV = "OPENTEAM_UPDATE_AGENT_CLI";
/**
 * The same runtime by a path that outlives an upgrade of it. Homebrew's versioned Cellar path
 * disappears on `brew upgrade`, while its `opt` link and the copy on PATH follow the upgrade.
 */
export const stableRuntimePath = (executable: string, environment = process.env): string => {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const target = real(executable);
  if (!target) return executable;
  const cellar = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(executable);
  const candidates = [
    ...(cellar ? [join(cellar[1]!, "opt", cellar[2]!, cellar[3]!)] : []),
    ...(environment.PATH ?? "")
      .split(delimiter)
      .filter((directory) => isAbsolute(directory))
      .map((directory) => join(directory, basename(executable))),
  ];
  return candidates.find((candidate) => real(candidate) === target) ?? executable;
};

/** The program that runs this CLI: a standalone binary itself, or the runtime running its script. */
const runtimeExecutable = (environment = process.env): string =>
  isBunStandaloneExecutable() ? process.execPath : stableRuntimePath(process.execPath, environment);

export const updateAgentExecutable = (
  environment = process.env,
  executable = runtimeExecutable(environment)
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
// A claim whose PID never appears belongs to an agent that died while starting.
const ABANDONED_CLAIM_MS = 30_000;

/**
 * Whether `pid` is this installation's agent. After a reboot the recorded PID can belong to an
 * unrelated process, which must not keep the agent off.
 */
export const isUpdateAgentProcess = (
  pid: number,
  directory: string,
  platform = process.platform
): boolean => {
  if (!alive(pid)) return false;
  try {
    if (platform === "darwin") {
      const ps = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      });
      if (ps.error) return true;
      // A directory with spaces spans several words, so match the text.
      return ps.status === 0 && / status /.test(ps.stdout) && ps.stdout.includes(` ${directory}`);
    }
    if (platform !== "linux") return true;
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes("status") && args.includes(directory);
  } catch {
    return false;
  }
};

export const runningUpdateAgent = (paths: InstallationPaths): number | null => {
  const owner = lockOwner(paths);
  return owner && isUpdateAgentProcess(owner, paths.directory) ? owner : null;
};

/** The command the service manager or the CLI runs to start this installation's agent. */
export const updateAgentCommand = (paths: InstallationPaths): UpdateAgentCommand => {
  const executable = updateAgentExecutable();
  const environment: Record<string, string> = {
    [UPDATE_AGENT_ENV]: "1",
    [UPDATE_AGENT_CLI_ENV]: executable,
  };
  // Service managers start with a minimal environment; keep what finds and reaches Docker.
  for (const name of [
    "PATH",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return {
    executable,
    args: updateWorkerArguments([
      process.argv[0]!,
      process.argv[1]!,
      "status",
      "--dir",
      paths.directory,
    ]),
    environment,
  };
};

/**
 * No new listener, network port, or desktop credentials: the host polls its own installation.
 * On macOS and systemd Linux the agent is registered to start again after a reboot or sign-in.
 */
export const ensureUpdateAgent = (
  paths: InstallationPaths,
  host: ServiceHost = systemServiceHost()
): void => {
  if (!readManifest(paths)?.ownerUsername) return;
  const running = runningUpdateAgent(paths) !== null;
  const command = updateAgentCommand(paths);
  try {
    const service = installUpdateAgentService(paths, command, running, host);
    if (service.managed) {
      if (service.linger)
        console.warn(
          `Server updates start when you sign in to this host, not at boot. To start them at boot, run: ${service.linger}`
        );
      return;
    }
    if (service.warning)
      console.warn(
        `Server updates will stay off after a reboot until you run openteam start (${service.warning}).${service.linger ? ` To start them at boot, run: ${service.linger}, then openteam start.` : ""}`
      );
  } catch (error) {
    console.warn(
      `Server updates will stay off after a reboot until you run openteam start (${error instanceof Error ? error.message : error}).`
    );
  }
  if (running) return;
  const installedExecutable = command.executable;
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
  const child = spawn(executable, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...workerEnvironment(), ...command.environment },
  });
  events(child).on("error", (error) =>
    console.warn(`Server updates could not be enabled: ${error.message}`)
  );
  child.unref();
};

/** `openteam stop` and `uninstall`: stop the agent and keep it from starting at the next boot. */
export const stopUpdateAgent = (
  paths: InstallationPaths,
  host: ServiceHost = systemServiceHost()
): void => {
  try {
    removeUpdateAgentService(paths, host);
  } catch (error) {
    console.warn(
      `Could not remove the server updater's startup entry: ${error instanceof Error ? error.message : error}`
    );
  }
  const pid = runningUpdateAgent(paths);
  if (pid && host.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
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
  if (owner && isUpdateAgentProcess(owner, paths.directory)) return;
  if (!owner) {
    let claimedAt: number | null = null;
    try {
      claimedAt = statSync(lockPath(paths)).mtimeMs;
    } catch {
      // No claim yet.
    }
    // An incomplete claim is another daemon starting; leave it time to write its PID.
    if (claimedAt !== null && Date.now() - claimedAt < ABANDONED_CLAIM_MS) return;
  }
  rmSync(lockPath(paths), { recursive: true, force: true });
  try {
    mkdirSync(lockPath(paths), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
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
