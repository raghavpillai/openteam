import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "../agent-process";
import type { ScreenSession } from "./types";

export const SCREEN_HEALTH_CHECK_INTERVAL_MS = 2_000;

export const ENDPOINT_PROBE_TIMEOUT_MS = 1_000;
const endpointFailures = new WeakMap<ScreenSession, number>();

export const processError = (command: string, stderr: string, code: number | null) =>
  new Error(`${command} exited ${code ?? "without a code"}${stderr ? `: ${stderr.trim()}` : ""}`);

export const run = async (
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    captureStdout?: boolean;
    failOnStderr?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      env: options.env,
      ...agentProcessIdentity(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    // Wait for stdio to drain; exit can arrive before xdotool's error output.
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (code === 0 && !(options.failOnStderr && stderr.trim()))
        resolve(options.captureStdout ? Buffer.concat(stdout) : Buffer.alloc(0));
      else reject(processError(command, stderr, code));
    });
  });

export const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export function removeProcess(session: ScreenSession, child: ChildProcess): boolean {
  const index = session.processes.indexOf(child);
  if (index < 0) return false;
  session.processes.splice(index, 1);
  return true;
}

export function failSession(session: ScreenSession, error: string): void {
  if (session.destroyed || session.stopping) return;
  session.state = "failed";
  session.error = error;
}

export async function stopProcesses(session: ScreenSession): Promise<void> {
  const processes = [...session.processes];
  if (processes.length === 0) {
    session.browserProcess = null;
    return;
  }
  const wasStopping = session.stopping;
  session.stopping = true;
  try {
    for (const process of processes) process.kill("SIGTERM");
    await waitForProcessExit(processes, 2_000);
    const survivors = processes.filter((process) => !processHasExited(process));
    for (const process of survivors) process.kill("SIGKILL");
    await waitForProcessExit(survivors, 2_000);
  } finally {
    session.stopping = wasStopping;
    session.processes = [];
    session.browserProcess = null;
  }
}

export async function waitForProcessExit(
  processes: ChildProcess[],
  timeoutMs: number
): Promise<void> {
  if (processes.every((process) => processHasExited(process))) return;
  await Promise.race([
    Promise.all(
      processes.map(
        (process) =>
          new Promise<void>((resolve) => {
            if (processHasExited(process)) resolve();
            else process.once("exit", () => resolve());
          })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function processHasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

export async function refreshSessionHealth(session: ScreenSession): Promise<void> {
  if (Date.now() - session.lastHealthCheckAt < SCREEN_HEALTH_CHECK_INTERVAL_MS) return;
  if (!session.healthCheckPromise) {
    session.lastHealthCheckAt = Date.now();
    const probe = sessionEndpointsReady(session).then((healthy) => {
      const failures = healthy ? 0 : (endpointFailures.get(session) ?? 0) + 1;
      // A single slow HEAD request must not destroy the user's desktop/browser.
      // Process exits still fail immediately through the process listeners.
      endpointFailures.set(session, failures >= 2 ? 0 : failures);
      if (failures >= 2) failSession(session, "The VNC or noVNC endpoint stopped responding");
      return healthy;
    });
    session.healthCheckPromise = probe;
    void probe.finally(() => {
      if (session.healthCheckPromise === probe) session.healthCheckPromise = null;
    });
  }
  await session.healthCheckPromise;
}

export async function sessionEndpointsReady(session: ScreenSession): Promise<boolean> {
  const [vncReady, viewerReady] = await Promise.all([
    tcpPortAccepts(session.rfbPort),
    viewerHttpResponds(session.viewerPort),
  ]);
  return vncReady && viewerReady;
}

export async function tcpPortAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(ENDPOINT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function viewerHttpResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/openteam.html`, {
      method: "HEAD",
      signal: AbortSignal.timeout(ENDPOINT_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function environment(home: string, session: ScreenSession): NodeJS.ProcessEnv {
  const environment = sanitizedAgentEnvironment(process.env);
  return {
    ...environment,
    HOME: home,
    DISPLAY: `:${session.display}`,
    XDG_RUNTIME_DIR: session.runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(session.runtimeDirectory, "bus")}`,
    XDG_CONFIG_HOME: join(session.runtimeDirectory, "config"),
    XDG_CACHE_HOME: join(session.runtimeDirectory, "cache"),
    XDG_DATA_HOME: join(session.runtimeDirectory, "data"),
    XDG_CURRENT_DESKTOP: "XFCE",
    XDG_SESSION_DESKTOP: "xfce",
    DESKTOP_SESSION: "xfce",
    XDG_SESSION_TYPE: "x11",
    GDK_BACKEND: "x11",
    GTK_THEME: "Adwaita",
    OPENTEAM_SCREEN_CWD: session.cwd,
    OPENTEAM_BROWSER_PROFILE: session.profileDirectory,
    OPENTEAM_BROWSER_DEBUG_PORT: String(session.browserDebugPort),
  };
}
