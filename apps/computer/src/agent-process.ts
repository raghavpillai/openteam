import { execFile, spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { nodeBinary } from "./node-runtime";

const DEFAULT_AGENT_UID = 1001;
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

/** Signal an agent-owned child using its identity, without CAP_KILL on the host. */
export function signalAgentProcess(child: ChildProcess, signal: NodeJS.Signals | number = "SIGTERM", group = false): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  const identity = agentProcessIdentity();
  if (identity.uid === undefined) {
    if (!group) return child.kill(signal);
    try { process.kill(-child.pid, signal); return true; } catch { return false; }
  }
  // Use the syscall API so a negative group ID cannot be parsed as a CLI option.
  const result = spawnSync(nodeBinary(), ["-e", "const [pid, signal] = JSON.parse(process.argv[1]); process.kill(pid, signal);", "--", JSON.stringify([group ? -child.pid : child.pid, signal])], {
    ...identity, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 2_000,
  });
  return result.status === 0;
}

/** Bun now honors uid/gid; cancellation must use the same dropped identity. */
export const spawnAgentProcess: typeof spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
  const identity = agentProcessIdentity();
  if (identity.uid === undefined) return spawn(command, args, options);
  const { signal, ...rest } = options;
  signal?.throwIfAborted();
  const child = spawn(command, args, { ...rest, ...identity });
  child.kill = (signal = "SIGTERM") => {
    const sent = signalAgentProcess(child, signal);
    if (sent) Object.defineProperty(child, "killed", { value: true, configurable: true });
    return sent;
  };
  const abort = () => {
    child.kill(options.killSignal ?? "SIGTERM");
    const error = Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), { name: "AbortError", code: "ABORT_ERR" });
    child.emit("error", error);
  };
  if (signal) {
    signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) queueMicrotask(abort);
  }
  return child;
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
