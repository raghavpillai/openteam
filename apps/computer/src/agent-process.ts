import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { desktopMemoryForSpawn } from "./desktop-memory";

const DEFAULT_AGENT_UID = 1000;
const DEFAULT_AGENT_GID = 1000;

const numericIdentity = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export interface AgentProcessIdentity {
  uid?: number;
  gid?: number;
}

export const agentProcessIdentity = (): AgentProcessIdentity => {
  if (process.getuid?.() !== 0) return {};
  return {
    uid: numericIdentity(process.env.OPENTEAM_AGENT_UID, DEFAULT_AGENT_UID),
    gid: numericIdentity(process.env.OPENTEAM_AGENT_GID, DEFAULT_AGENT_GID),
  };
};

/** Host-created GUI state belongs to the desktop user; never follow symlinks. */
export async function assignAgentOwnership(paths: string[], recursive = false): Promise<void> {
  const { uid, gid } = agentProcessIdentity();
  if (uid === undefined || gid === undefined || !paths.length) return;
  await new Promise<void>((resolve, reject) => {
    execFile("/bin/chown", [...(recursive ? ["-R"] : []), "--no-dereference", `${uid}:${gid}`, "--", ...paths],
      { env: { PATH: "/usr/bin:/bin" } }, error => error ? reject(error) : resolve());
  });
}

/** The administrator gateway can signal its agent-owned children directly. */
export function signalAgentProcess(child: ChildProcess, signal: NodeJS.Signals | number = "SIGTERM", group = false): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (!group) return child.kill(signal);
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
}

/** Only for a child spawned with detached:true. Valid until its pipes close,
 * including the interval where the group leader exited but descendants remain. */
export function agentProcessGroupSignaler(child: ChildProcess): (signal: NodeJS.Signals) => boolean {
  const pid = child.pid;
  let closed = false;
  child.once("close", () => { closed = true; });
  return signal => {
    if (!pid || closed) return false;
    try { process.kill(-pid, signal); return true; } catch { return false; }
  };
}

/** Initialize supplementary groups as well as the ordinary account's UID/GID. */
export const spawnAgentProcess: typeof spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
  const identity = agentProcessIdentity();
  const desktopId = options.env?.OPENTEAM_DESKTOP_ID;
  const group = desktopId ? desktopMemoryForSpawn(desktopId) : undefined;
  if (identity.uid === undefined) return spawn(command, args, options);
  if (group && options.shell) throw new Error("A capped desktop command must not use a supervisor shell");
  const { uid: _uid, gid: _gid, ...rest } = options;
  const identityArgs = ["--reuid", String(identity.uid), "--regid", String(identity.gid), "--init-groups", "--", command, ...args];
  // Join before setpriv/exec so ordinary commands and sudo descendants inherit
  // the budget while retaining the computer's administrator-access behavior.
  return group
    ? spawn("/usr/local/bin/openteam-desktop-exec", [group, "/usr/bin/setpriv", ...identityArgs], rest)
    : spawn("/usr/bin/setpriv", identityArgs, rest);
}) as typeof spawn;

const ALWAYS_PRIVATE_ENVIRONMENT_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "BASH_ENV",
  "DATABASE_URL",
  "ENV",
  "NODE_OPTIONS",
  "OPENTEAM_PI_AGENT_DIR",
  "PYTHONSTARTUP",
  "RUBYOPT",
]);

const SECRET_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:$|_)/i;

export const sanitizedAgentEnvironment = (
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...source, ...overrides };
  for (const key of Object.keys(environment)) {
    if (ALWAYS_PRIVATE_ENVIRONMENT_KEYS.has(key) || SECRET_ENVIRONMENT_KEY.test(key)) {
      delete environment[key];
    }
  }
  return environment;
};
