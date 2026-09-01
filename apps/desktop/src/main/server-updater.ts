import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { SystemVersionView } from "@openbot/contracts";
import { isOpenBotVersion } from "@openbot/contracts/version-compatibility";
import { redactSensitiveText, safeErrorMessage } from "@openbot/product-core/redaction";

const UPDATE_EVENT_PREFIX = "@@OPENBOT_UPDATE@@";
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
  if (environment.OPENBOT_HOME?.trim()) return resolve(environment.OPENBOT_HOME.trim());
  if (platform === "win32") {
    return resolve(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "OpenBot");
  }
  if (environment.XDG_CONFIG_HOME?.trim()) {
    return resolve(environment.XDG_CONFIG_HOME.trim(), "openbot");
  }
  return resolve(home, ".openbot");
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
    if (typeof manifest.version !== "string" || !isOpenBotVersion(manifest.version)) return null;
    const values = environmentValues(readFileSync(environmentPath, "utf8"));
    return {
      directory,
      version: manifest.version,
      apiPort: values.get("OPENBOT_API_PORT") || "8787",
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
        "rolling-back",
        "complete",
      ].includes(String(value.phase)) ||
      typeof value.message !== "string"
    ) {
      return null;
    }
    return value as UpdateEvent;
  } catch {
    return null;
  }
};

const manualCommand = (version: string | null) =>
  version && isOpenBotVersion(version) ? `openbot update --version ${version}` : "openbot update";

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
      headers: { accept: "application/json", "user-agent": "OpenBot-Desktop" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as Partial<SystemVersionView>;
    if (
      typeof value.releaseVersion !== "string" ||
      !isOpenBotVersion(value.releaseVersion) ||
      !Number.isInteger(value.apiProtocolVersion)
    ) {
      return null;
    }
    return value as SystemVersionView;
  } catch {
    return null;
  }
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
    // Version discovery is useful for every server, even when this computer is
    // not allowed to manage that server's Docker installation. The renderer
    // also checks the endpoint, but the main-process result keeps remote and
    // cross-origin connections reliable and gives every caller one complete
    // status object.
    const release = await fetchVersion(this.options.fetcher ?? fetch, serverUrl);
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
    };
    return this.snapshot;
  }

  async update(
    serverUrl: string,
    targetVersion: string | null,
    sshTarget?: string | null
  ): Promise<ServerUpdateStatus> {
    if (targetVersion !== null && !isOpenBotVersion(targetVersion))
      throw new Error("The requested OpenBot version is invalid");
    if (this.child) throw new Error("An OpenBot server update is already running");
    const before = await this.status(serverUrl, targetVersion, sshTarget);
    if (!before.updaterAvailable) {
      throw new Error(`Run ${before.manualCommand} on the server computer`);
    }
    const installation = readManagedInstallation(this.options.environment ?? process.env);
    if (before.updateMethod === "local" && !installation) {
      throw new Error("The local OpenBot installation could not be read");
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
    const remoteUpdateArguments = [
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
      "openbot",
      "update",
      ...(targetVersion ? ["--version", targetVersion] : []),
      "--json-progress",
    ];
    const local = before.updateMethod === "local";
    const child = (this.options.spawnUpdater ?? spawn)(
      local ? this.options.executablePath : (this.options.sshExecutable ?? "ssh"),
      local ? localUpdateArguments : remoteUpdateArguments,
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
    let output = "";
    const progressLines = new BoundedUpdateLineBuffer();
    let completedVersion: string | null = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = appendBoundedOutput(output, chunk);
      for (const line of progressLines.push(chunk)) {
        const event = parseUpdateEvent(line);
        if (!event) continue;
        if (event.phase === "complete" && event.version && isOpenBotVersion(event.version)) {
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
        });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      output = appendBoundedOutput(output, chunk);
    });

    return new Promise<ServerUpdateStatus>((resolvePromise, reject) => {
      child.once("error", (error) => {
        this.child = null;
        const message = safeErrorMessage(error);
        publish({ status: "error", message });
        reject(new Error(message));
      });
      child.once("close", async (code) => {
        this.child = null;
        if (code !== 0) {
          const message = redactSensitiveText(
            output.trim().split(/\r?\n/).at(-1) || `Updater exited with code ${code}`
          );
          publish({ status: "error", message });
          reject(new Error(message));
          return;
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
          apiProtocolVersion:
            release?.apiProtocolVersion ?? this.snapshot?.apiProtocolVersion ?? null,
        });
        resolvePromise(this.snapshot as ServerUpdateStatus);
      });
    });
  }
}
