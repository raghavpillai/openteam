import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DOCKER_CLI_MISSING } from "./docker-diagnostics";
import type { DoctorResult } from "./doctor";
import type { CommandRunner, RunResult } from "./process";
import { TerminalReport, type TerminalOptions } from "./terminal";

const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";
const DOCKER_ENGINE_URL = "https://docs.docker.com/engine/install/";
const START_TIMEOUT_MS = 120_000;

export const dockerDesktopApplication = (
  candidates: readonly string[] = [
    "/Applications/Docker.app",
    join(homedir(), "Applications", "Docker.app"),
  ]
): string | null => candidates.find((candidate) => existsSync(candidate)) ?? null;

/**
 * True when preflight failed because Docker is not installed. A docker file on PATH that cannot
 * run is a broken installation instead, which the full preflight report explains.
 */
export const dockerMissing = (result: DoctorResult, path = process.env.PATH ?? ""): boolean =>
  result.checks.some(
    (check) =>
      check.label === "Docker CLI" && check.level === "fail" && check.detail === DOCKER_CLI_MISSING
  ) &&
  !path
    .split(delimiter)
    .some(
      (entry) => entry && ["docker", "docker.exe"].some((name) => existsSync(join(entry, name)))
    );

/** The whole answer when Docker is missing: where to get it and how to continue. */
export const renderDockerRequired = (
  setupCommand: string,
  options: TerminalOptions & { platform?: NodeJS.Platform; desktopStarting?: boolean } = {}
): string => {
  const platform = options.platform ?? process.platform;
  const view = new TerminalReport(options);
  view.lines.push("");
  if (options.desktopStarting) {
    view.notice("Docker Desktop is installed but not ready.", "error");
    view.text("Open Docker Desktop and finish its setup.", "info", 4);
  } else {
    view.notice("Docker is required.", "error");
    view.text(
      platform === "linux"
        ? `Install Docker Engine and the Compose plugin: ${DOCKER_ENGINE_URL}`
        : `Install Docker Desktop: ${DOCKER_DESKTOP_URL}`,
      "info",
      4
    );
  }
  view.text(`Then run: ${setupCommand}`, "info", 4);
  view.lines.push("");
  return view.toString();
};

const engineStopped = (result: RunResult): boolean =>
  /cannot connect to the docker daemon|is the docker daemon running|connection refused|no such file or directory/i.test(
    `${result.stderr} ${result.stdout} ${result.error?.message ?? ""}`
  );

/** Docker Desktop's own contexts; others, such as Colima or OrbStack, are left alone. */
const DESKTOP_CONTEXTS = ["desktop-linux", "default"];

export type DockerDesktopStart = "skipped" | "ready" | "timed-out";

/**
 * In an interactive macOS terminal, open Docker Desktop when it is installed but its engine
 * is stopped, then wait for the engine instead of failing preflight. Other engines, such as
 * a DOCKER_HOST or another runtime's context, are left alone; preflight reports them as before.
 */
export const startDockerDesktop = async (
  runner: CommandRunner,
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    application?: string | null;
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    output?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  } = {}
): Promise<DockerDesktopStart> => {
  const output = options.output ?? process.stdout;
  if ((options.platform ?? process.platform) !== "darwin" || !output.isTTY) return "skipped";
  if ((options.environment ?? process.env).DOCKER_HOST?.trim()) return "skipped";
  const application =
    options.application === undefined ? dockerDesktopApplication() : options.application;
  if (!application) return "skipped";
  const cli = runner.run("docker", ["--version"]);
  if (cli.status === 0) {
    const context = runner.run("docker", ["context", "inspect", "--format", "{{.Name}}"], {
      timeoutMs: 10_000,
    });
    if (context.status !== 0 || !DESKTOP_CONTEXTS.includes(context.stdout.trim())) return "skipped";
    const daemon = runner.run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 10_000,
    });
    if (daemon.status === 0 || !engineStopped(daemon)) return "skipped";
  }
  // A Docker Desktop that has never been opened has not installed its docker command yet.
  if (runner.run("open", ["-a", application]).status !== 0) return "skipped";

  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  const animated = (options.environment ?? process.env).TERM !== "dumb";
  const view = new TerminalReport();
  const started = now();
  output.write(`${view.notice("Starting Docker Desktop…", "info").toString()}\n`);
  let ready = false;
  while (now() - started < timeoutMs) {
    ready =
      runner.run("docker", ["--version"]).status === 0 &&
      runner.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 })
        .status === 0;
    if (ready) break;
    if (animated) {
      const seconds = Math.round((now() - started) / 1000);
      output.write(`\r\x1b[2K${view.paint(`    Waiting for Docker to be ready… ${seconds}s`)}`);
    }
    await sleep(options.intervalMs ?? 2_000);
  }
  if (animated) output.write("\r\x1b[2K");
  const result = new TerminalReport();
  if (ready) result.notice("Docker Desktop is running.", "success");
  else result.notice("Docker Desktop did not finish starting within 2 minutes.", "warning");
  output.write(`${result.toString()}\n`);
  return ready ? "ready" : "timed-out";
};
