import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { SystemVersionView } from "@openteam/contracts";
import { isOpenTeamVersion } from "@openteam/contracts/version-compatibility";
import { redactSensitiveText, safeErrorMessage } from "@openteam/product-core/redaction";

const UPDATE_EVENT_PREFIX = "@@OPENTEAM_UPDATE@@";
const MAX_ERROR_OUTPUT = 12_000;
export const MAX_UPDATE_PROGRESS_LINE = 128 * 1024;

/**
 * Frames updater output without repeatedly copying an unfinished line.
 * Oversized lines are discarded through their newline so a noisy child or SSH
 * peer cannot monopolize the Electron main thread.
 */
export class BoundedUpdateLineBuffer {
  private pending = "";
  private discarding = false;

  get bufferedLength(): number {
    return this.pending.length;
  }

  push(chunk: string): string[] {
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.discarding) {
        const available = MAX_UPDATE_PROGRESS_LINE - this.pending.length;
        if (end - offset <= available) {
          this.pending += chunk.slice(offset, end);
        } else {
          this.pending = "";
          this.discarding = true;
        }
      }
      if (newline < 0) break;
      if (!this.discarding) {
        lines.push(this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending);
      }
      this.pending = "";
      this.discarding = false;
      offset = newline + 1;
    }
    return lines;
  }
}

const appendBoundedOutput = (current: string, chunk: string) =>
  chunk.length >= MAX_ERROR_OUTPUT
    ? chunk.slice(-MAX_ERROR_OUTPUT)
    : `${current}${chunk}`.slice(-MAX_ERROR_OUTPUT);

export type ServerUpdatePhase =
  | "checking"
  | "downloading"
  | "backing-up"
  | "pulling"
  | "restarting"
  | "verifying"
  | "updating-cli"
  | "rolling-back"
  | "complete";

export interface ServerUpdateStatus {
  serverUrl: string;
  currentVersion: string | null;
  targetVersion: string | null;
  apiProtocolVersion: number | null;
  minimumClientVersion: string | null;
  maximumClientVersionExclusive: string | null;
  recommendedClientVersion: string | null;
  updateMethod: "local" | "ssh" | "manual";
  updaterAvailable: boolean;
  status: "ready" | "updating" | "updated" | "unavailable" | "error";
  phase: ServerUpdatePhase | null;
  message: string | null;
  manualCommand: string;
  jobId: string | null;
  safeToCloseDesktop: boolean;
}

interface Installation {
  directory: string;
  version: string;
  apiPort: string;
}

interface UpdateEvent {
  phase: ServerUpdatePhase;
  message: string;
  version?: string;
  jobId?: string;
  safeToCloseDesktop?: boolean;
}

interface PersistedUpdateState {
  schemaVersion: 1;
  jobId: string;
  status: "running" | "complete" | "error";
  phase: ServerUpdatePhase | "error";
  fromVersion: string;
  targetVersion: string | null;
  message: string;
  workerPid?: number;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type UpdaterProcess = ChildProcessByStdio<null, Readable, Readable>;
type SpawnUpdater = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }
) => UpdaterProcess;

const defaultInstallDirectory = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  home = homedir()
) => {
  if (environment.OPENTEAM_HOME?.trim()) return resolve(environment.OPENTEAM_HOME.trim());
  if (platform === "win32") {
    return resolve(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "OpenTeam");
  }
  if (environment.XDG_CONFIG_HOME?.trim()) {
    return resolve(environment.XDG_CONFIG_HOME.trim(), "openteam");
  }
  return resolve(home, ".openteam");
};

const environmentValues = (contents: string) => {
  const result = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    result.set(key, value);
  }
  return result;
};

export const readManagedInstallation = (
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): Installation | null => {
  const directory = defaultInstallDirectory(environment, platform, home);
  const manifestPath = join(directory, "installation.json");
  const environmentPath = join(directory, ".env");
  const composePath = join(directory, "compose.yaml");
  if (!existsSync(manifestPath) || !existsSync(environmentPath) || !existsSync(composePath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || !isOpenTeamVersion(manifest.version)) return null;
    const values = environmentValues(readFileSync(environmentPath, "utf8"));
    return {
      directory,
      version: manifest.version,
      apiPort: values.get("OPENTEAM_API_PORT") || "8787",
    };
  } catch {
    return null;
  }
};

const loopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export const canManageServer = (serverUrl: string, installation: Installation | null): boolean => {
  if (!installation) return false;
  try {
    const url = new URL(serverUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return url.protocol === "http:" && loopbackHost(url.hostname) && port === installation.apiPort;
  } catch {
    return false;
  }
};

export const parseUpdateEvent = (line: string): UpdateEvent | null => {
  if (!line.startsWith(UPDATE_EVENT_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(UPDATE_EVENT_PREFIX.length)) as Partial<UpdateEvent>;
    if (
      ![
        "checking",
        "downloading",
        "backing-up",
        "pulling",
        "restarting",
        "verifying",
        "updating-cli",
        "rolling-back",
        "complete",
      ].includes(String(value.phase)) ||
      typeof value.message !== "string" ||
      (value.jobId !== undefined &&
        (typeof value.jobId !== "string" || value.jobId.length > 128)) ||
      (value.safeToCloseDesktop !== undefined && typeof value.safeToCloseDesktop !== "boolean")
    ) {
      return null;
    }
    return value as UpdateEvent;
  } catch {
    return null;
  }
};

const readPersistedUpdateState = (
  installation: Installation | null
): PersistedUpdateState | null => {
  if (!installation) return null;
  try {
    const value = JSON.parse(
      readFileSync(join(installation.directory, "update-state.json"), "utf8")
    ) as Partial<PersistedUpdateState>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.jobId !== "string" ||
      !["running", "complete", "error"].includes(String(value.status)) ||
      ![
        "checking",
        "downloading",
        "backing-up",
        "pulling",
        "restarting",
        "verifying",
        "updating-cli",
        "rolling-back",
        "complete",
        "error",
      ].includes(String(value.phase)) ||
      typeof value.message !== "string"
    ) {
      return null;
    }
    return value as PersistedUpdateState;
  } catch {
    return null;
  }
};

const processIsAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Matches the CLI's own check: a standalone CLI records its worker PID while it stages the
 * target CLI, before the server transaction takes the update lock.
 */
const persistedUpdateIsActive = (
  installation: Installation | null,
  persisted: PersistedUpdateState
): boolean => {
  if (!installation) return false;
  try {
    const owner = JSON.parse(
      readFileSync(join(installation.directory, "update.lock", "owner.json"), "utf8")
    ) as { pid?: unknown };
    if (processIsAlive(owner.pid)) return true;
  } catch {
    // No server transaction holds the lock yet.
  }
  return processIsAlive(persisted.workerPid);
};

const manualCommand = (version: string | null) =>
  version && isOpenTeamVersion(version)
    ? `openteam update --version ${version}`
    : "openteam update";

export const normalizeSshTarget = (value: string | null | undefined): string | null => {
  const target = value?.trim() ?? "";
  if (!target || target.length > 255) return null;
  return /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(target)
    ? target
    : null;
};

const versionEndpoint = (serverUrl: string) => {
  const url = new URL(serverUrl);
  url.pathname = "/api/v0/system/version";
  url.search = "";
  url.hash = "";
  return url;
};

const fetchVersion = async (
  fetcher: Fetcher,
  serverUrl: string
): Promise<SystemVersionView | null> => {
  try {
    const response = await fetcher(versionEndpoint(serverUrl), {
      headers: { accept: "application/json", "user-agent": "OpenTeam-Desktop" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as Partial<SystemVersionView>;
    if (
      typeof value.releaseVersion !== "string" ||
      !isOpenTeamVersion(value.releaseVersion) ||
      !Number.isInteger(value.apiProtocolVersion)
    ) {
      return null;
    }
    return value as SystemVersionView;
  } catch {
    return null;
  }
};

/** A POSIX shell exits 127 when the remote `openteam` command is not on its PATH. */
const REMOTE_COMMAND_NOT_FOUND = 127;

/**
 * Non-interactive SSH sessions skip login profiles, so the installer's default ~/.local/bin is
 * usually missing from PATH. The fallback adds it through `sh`, which any login shell can run.
 */
export const remoteOpenTeamCommand = (
  args: readonly string[],
  useDefaultInstallPath = false
): string[] =>
  useDefaultInstallPath
    ? [
        "sh",
        "-c",
        `'PATH="$HOME/.local/bin:$PATH"; export PATH; exec openteam "$@"'`,
        "openteam",
        ...args,
      ]
    : ["openteam", ...args];

/** The CLI prints its final error as a wrapped `✗` block; return the whole message. */
export const updaterFailureMessage = (output: string, code: number | null): string => {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const start = lines.findLastIndex((line) => line.trimStart().startsWith("✗ "));
  if (start < 0) {
    return lines.findLast((line) => line.trim())?.trim() || `Updater exited with code ${code}`;
  }
  const message = [lines[start]?.trimStart().slice(2).trim() ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s{3,}\S/.test(line)) break;
    message.push(line.trim());
  }
  return message.join(" ");
};

const fetchRemoteUpdateProgress = async (options: {
  target: string;
  executable: string;
  environment: NodeJS.ProcessEnv;
  spawnUpdater: SpawnUpdater;
}): Promise<UpdateEvent | null> => {
  const query = (useDefaultInstallPath: boolean) =>
    new Promise<{ code: number | null; latest: UpdateEvent | null }>((resolvePromise) => {
      let child: UpdaterProcess;
      try {
        child = options.spawnUpdater(
          options.executable,
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=5",
            options.target,
            ...remoteOpenTeamCommand(["status", "--json-progress"], useDefaultInstallPath),
          ],
          { env: options.environment, stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch {
        resolvePromise({ code: null, latest: null });
        return;
      }
      const lines = new BoundedUpdateLineBuffer();
      let latest: UpdateEvent | null = null;
      child.stdout.setEncoding("utf8");
      child.stderr.resume();
      child.stdout.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) latest = parseUpdateEvent(line) ?? latest;
      });
      const timeout = setTimeout(() => child.kill(), 8_000);
      timeout.unref?.();
      child.once("error", () => {
        clearTimeout(timeout);
        resolvePromise({ code: null, latest: null });
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolvePromise({ code, latest });
      });
    });
  const first = await query(false);
  return first.code === REMOTE_COMMAND_NOT_FOUND ? (await query(true)).latest : first.latest;
};

export class ServerUpdater {
  private child: UpdaterProcess | null = null;
  private snapshot: ServerUpdateStatus | null = null;
  private statusInFlight: { key: string; request: Promise<ServerUpdateStatus> } | null = null;

  constructor(
    private readonly options: {
      cliPath: string;
      executablePath: string;
      environment?: NodeJS.ProcessEnv;
      fetcher?: Fetcher;
      spawnUpdater?: SpawnUpdater;
      sshExecutable?: string;
      onStatus?: (status: ServerUpdateStatus) => void;
    }
  ) {}

  async status(
    serverUrl: string,
    targetVersion: string | null,
    sshTarget?: string | null
  ): Promise<ServerUpdateStatus> {
    if (this.child && this.snapshot) return this.snapshot;
    const key = JSON.stringify([serverUrl, targetVersion, normalizeSshTarget(sshTarget)]);
    if (this.statusInFlight?.key === key) return this.statusInFlight.request;
    const request = this.readStatus(serverUrl, targetVersion, sshTarget);
    this.statusInFlight = { key, request };
    try {
      return await request;
    } finally {
      if (this.statusInFlight?.request === request) this.statusInFlight = null;
    }
  }

  private async readStatus(
    serverUrl: string,
    targetVersion: string | null,
    sshTarget?: string | null
  ): Promise<ServerUpdateStatus> {
    const environment = this.options.environment ?? process.env;
    const installation = readManagedInstallation(environment);
    const locallyManaged =
      canManageServer(serverUrl, installation) && existsSync(this.options.cliPath);
    const remoteTarget = normalizeSshTarget(sshTarget);
    const updateMethod = locallyManaged ? "local" : remoteTarget ? "ssh" : "manual";
    const updaterAvailable = updateMethod !== "manual";
    const persisted = locallyManaged ? readPersistedUpdateState(installation) : null;
    if (persisted?.status === "running" && persistedUpdateIsActive(installation, persisted)) {
      this.snapshot = {
        serverUrl,
        currentVersion: installation?.version ?? persisted.fromVersion,
        targetVersion: persisted.targetVersion ?? targetVersion,
        apiProtocolVersion: null,
        minimumClientVersion: null,
        maximumClientVersionExclusive: null,
        recommendedClientVersion: null,
        updateMethod,
        updaterAvailable,
        status: "updating",
        phase: persisted.phase === "error" ? null : persisted.phase,
        message: persisted.message,
        manualCommand: manualCommand(targetVersion),
        jobId: persisted.jobId,
        safeToCloseDesktop: true,
      };
      return this.snapshot;
    }
    // Version discovery is useful for every server, even when this computer is
    // not allowed to manage that server's Docker installation. The renderer
    // also checks the endpoint, but the main-process result keeps remote and
    // cross-origin connections reliable and gives every caller one complete
    // status object.
    const release = await fetchVersion(this.options.fetcher ?? fetch, serverUrl);
    const pathEntries = [
      environment.PATH,
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ].filter((value): value is string => Boolean(value));
    const remoteProgress =
      !release && remoteTarget
        ? await fetchRemoteUpdateProgress({
            target: remoteTarget,
            executable: this.options.sshExecutable ?? "ssh",
            environment: {
              ...environment,
              PATH: [...new Set(pathEntries)].join(delimiter),
            },
            spawnUpdater: this.options.spawnUpdater ?? spawn,
          })
        : null;
    if (remoteProgress && remoteProgress.phase !== "complete") {
      this.snapshot = {
        serverUrl,
        currentVersion: null,
        targetVersion: remoteProgress.version ?? targetVersion,
        apiProtocolVersion: null,
        minimumClientVersion: null,
        maximumClientVersionExclusive: null,
        recommendedClientVersion: null,
        updateMethod,
        updaterAvailable,
        status: "updating",
        phase: remoteProgress.phase,
        message: remoteProgress.message,
        manualCommand: manualCommand(targetVersion),
        jobId: remoteProgress.jobId ?? null,
        safeToCloseDesktop: remoteProgress.safeToCloseDesktop === true,
      };
      return this.snapshot;
    }
    const currentVersion =
      release?.releaseVersion ?? (locallyManaged ? installation?.version : null) ?? null;
    this.snapshot = {
      serverUrl,
      currentVersion,
      targetVersion,
      apiProtocolVersion: release?.apiProtocolVersion ?? null,
      minimumClientVersion: release?.minimumClientVersion ?? null,
      maximumClientVersionExclusive: release?.maximumClientVersionExclusive ?? null,
      recommendedClientVersion: release?.recommendedClientVersion ?? null,
      updateMethod,
      updaterAvailable,
      status: updaterAvailable ? "ready" : "unavailable",
      phase: null,
      message: updaterAvailable
        ? release
          ? null
          : "Using the local installation record because this server predates version reporting."
        : "Configure an SSH destination to update this server securely from the desktop app.",
      manualCommand: manualCommand(targetVersion),
      jobId: persisted?.jobId ?? null,
      safeToCloseDesktop: false,
    };
    if (persisted?.status === "error") {
      this.snapshot.status = "error";
      this.snapshot.message = persisted.message;
    } else if (persisted?.status === "running") {
      this.snapshot.status = "error";
      this.snapshot.message =
        "The update worker stopped unexpectedly. Run the update again to recover safely.";
    }
    return this.snapshot;
  }

  async update(
    serverUrl: string,
    targetVersion: string | null,
    sshTarget?: string | null
  ): Promise<ServerUpdateStatus> {
    if (targetVersion !== null && !isOpenTeamVersion(targetVersion))
      throw new Error("The requested OpenTeam version is invalid");
    if (this.child) throw new Error("An OpenTeam server update is already running");
    const before = await this.status(serverUrl, targetVersion, sshTarget);
    if (!before.updaterAvailable) {
      throw new Error(`Run ${before.manualCommand} on the server computer`);
    }
    const installation = readManagedInstallation(this.options.environment ?? process.env);
    if (before.updateMethod === "local" && !installation) {
      throw new Error("The local OpenTeam installation could not be read");
    }

    const publish = (next: Partial<ServerUpdateStatus>) => {
      this.snapshot = { ...(this.snapshot ?? before), ...next };
      this.options.onStatus?.(this.snapshot);
    };
    publish({
      status: "updating",
      phase: "checking",
      message: targetVersion
        ? `Preparing to update the server to ${targetVersion}`
        : "Preparing to update the server to the latest release",
      targetVersion,
      safeToCloseDesktop: false,
    });

    const environment = this.options.environment ?? process.env;
    const pathEntries = [
      environment.PATH,
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/Applications/Docker.app/Contents/Resources/bin",
      "/usr/bin",
      "/bin",
    ].filter((value): value is string => Boolean(value));
    const localUpdateArguments = [
      this.options.cliPath,
      "update",
      "--dir",
      installation?.directory ?? "",
      ...(targetVersion ? ["--version", targetVersion] : []),
      "--json-progress",
    ];
    const remoteTarget = normalizeSshTarget(sshTarget);
    const remoteUpdateArguments = (useDefaultInstallPath: boolean) => [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      remoteTarget ?? "",
      ...remoteOpenTeamCommand(
        ["update", ...(targetVersion ? ["--version", targetVersion] : []), "--json-progress"],
        useDefaultInstallPath
      ),
    ];
    const local = before.updateMethod === "local";
    let output = "";
    let completedVersion: string | null = null;
    const runUpdater = (useDefaultInstallPath: boolean) =>
      new Promise<number | null>((resolveAttempt, rejectAttempt) => {
        const child = (this.options.spawnUpdater ?? spawn)(
          local ? this.options.executablePath : (this.options.sshExecutable ?? "ssh"),
          local ? localUpdateArguments : remoteUpdateArguments(useDefaultInstallPath),
          {
            env: {
              ...environment,
              ...(local ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
              PATH: [...new Set(pathEntries)].join(delimiter),
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        this.child = child;
        output = "";
        const progressLines = new BoundedUpdateLineBuffer();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output = appendBoundedOutput(output, chunk);
          for (const line of progressLines.push(chunk)) {
            const event = parseUpdateEvent(line);
            if (!event) continue;
            if (event.phase === "complete" && event.version && isOpenTeamVersion(event.version)) {
              completedVersion = event.version;
            }
            publish({
              status: event.phase === "complete" ? "updated" : "updating",
              phase: event.phase,
              message: event.message,
              currentVersion:
                event.phase === "complete"
                  ? (completedVersion ?? targetVersion ?? before.currentVersion)
                  : before.currentVersion,
              jobId: event.jobId ?? this.snapshot?.jobId ?? null,
              safeToCloseDesktop: event.safeToCloseDesktop === true,
            });
          }
        });
        child.stderr.on("data", (chunk: string) => {
          output = appendBoundedOutput(output, chunk);
        });
        child.once("error", rejectAttempt);
        child.once("close", resolveAttempt);
      });

    let code: number | null;
    try {
      code = await runUpdater(false);
      if (!local && code === REMOTE_COMMAND_NOT_FOUND) code = await runUpdater(true);
    } catch (error) {
      this.child = null;
      const message = safeErrorMessage(error);
      publish({ status: "error", message, safeToCloseDesktop: false });
      throw new Error(message);
    }
    this.child = null;
    if (code !== 0) {
      const message = redactSensitiveText(
        !local && code === REMOTE_COMMAND_NOT_FOUND
          ? `The openteam command was not found on ${remoteTarget}. Install the OpenTeam CLI there or add its directory to the PATH used by non-interactive SSH sessions.`
          : updaterFailureMessage(output, code)
      );
      publish({ status: "error", message, safeToCloseDesktop: false });
      throw new Error(message);
    }
    const release = await fetchVersion(this.options.fetcher ?? fetch, serverUrl);
    const installed = readManagedInstallation(this.options.environment ?? process.env);
    const currentVersion =
      completedVersion ?? release?.releaseVersion ?? installed?.version ?? targetVersion;
    publish({
      status: "updated",
      phase: "complete",
      message: currentVersion
        ? `Server and computer updated to ${currentVersion}`
        : "Server and computer update completed",
      currentVersion,
      apiProtocolVersion: release?.apiProtocolVersion ?? this.snapshot?.apiProtocolVersion ?? null,
      safeToCloseDesktop: false,
    });
    return this.snapshot as ServerUpdateStatus;
  }
}
