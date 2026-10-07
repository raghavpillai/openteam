import { existsSync, readFileSync } from "node:fs";
import { parseEnvironment, type InstallationPaths } from "./config";
import { PROJECT_NAME } from "./constants";
import { CliError } from "./errors";
import type { CommandRunner, RunResult } from "./process";
import semver from "semver";

export const MINIMUM_COMPOSE_VERSION = "2.20.0";

export interface ComposeCommand {
  executable: string;
  prefix: readonly string[];
  version: string;
  supported: boolean;
}

const usefulFailure = (result: RunResult): string =>
  result.stderr.trim() ||
  result.stdout.trim() ||
  result.error?.message ||
  "command failed; see the Docker output above";

const ADDRESS_POOLS_EXHAUSTED = "all predefined address pools have been fully subnetted";

export const ADDRESS_POOLS_EXHAUSTED_ADVICE =
  "Docker has no free subnets left for new networks. Remove unused networks with `docker network prune`, " +
  "or, if a VPN or cloud network route overlaps Docker's 172.17-31.x / 192.168.x defaults (check `ip route`), " +
  'set a non-overlapping pool in /etc/docker/daemon.json, e.g. {"default-address-pools":[{"base":"10.200.0.0/16","size":24}]}, ' +
  "restart Docker, and try again.";

// Inherited Compose output is not captured, so probe for subnet exhaustion directly.
const addressPoolsExhausted = (runner: CommandRunner): boolean => {
  const name = `openteam-subnet-probe-${process.pid}`;
  const probe = runner.run("docker", ["network", "create", name]);
  if (probe.status === 0) {
    runner.run("docker", ["network", "rm", name]);
    return false;
  }
  return `${probe.stderr}${probe.stdout}`.includes(ADDRESS_POOLS_EXHAUSTED);
};

export const dockerVersion = (runner: CommandRunner): RunResult =>
  runner.run("docker", ["--version"]);

export const dockerDaemon = (runner: CommandRunner): RunResult =>
  runner.run("docker", ["info", "--format", "{{.ServerVersion}}"]);

export const composeProcessEnvironment = (
  paths: InstallationPaths,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const environment = { ...inherited };
  if (!existsSync(paths.environment)) return environment;
  for (const key of parseEnvironment(readFileSync(paths.environment, "utf8")).keys()) {
    delete environment[key];
  }
  return environment;
};

export const probeCompose = (
  runner: CommandRunner
): { command: ComposeCommand | null; failures: Array<{ command: string; result: RunResult }> } => {
  const command = (executable: string, prefix: readonly string[], version: string) => {
    const parsed = semver.coerce(version);
    return {
      executable,
      prefix,
      version,
      supported: Boolean(parsed && semver.gte(parsed, MINIMUM_COMPOSE_VERSION)),
    };
  };
  const plugin = runner.run("docker", ["compose", "version"]);
  if (plugin.status === 0) {
    return { command: command("docker", ["compose"], plugin.stdout.trim()), failures: [] };
  }
  const standalone = runner.run("docker-compose", ["version"]);
  if (standalone.status === 0) {
    return { command: command("docker-compose", [], standalone.stdout.trim()), failures: [] };
  }
  return {
    command: null,
    failures: [
      { command: "docker compose version", result: plugin },
      { command: "docker-compose version", result: standalone },
    ],
  };
};

export const findCompose = (runner: CommandRunner): ComposeCommand | null =>
  probeCompose(runner).command;

export class ComposeProject {
  constructor(
    readonly paths: InstallationPaths,
    readonly command: ComposeCommand,
    private readonly runner: CommandRunner,
    readonly projectName = PROJECT_NAME
  ) {}

  invocation(args: readonly string[], composeFile = this.paths.compose) {
    if (!existsSync(composeFile)) throw new CliError(`Compose file not found: ${composeFile}`);
    return {
      command: this.command.executable,
      args: [
        ...this.command.prefix,
        "--project-name",
        this.projectName,
        "--project-directory",
        this.paths.directory,
        "--env-file",
        this.paths.environment,
        "--file",
        composeFile,
        ...args,
      ],
      cwd: this.paths.directory,
      env: composeProcessEnvironment(this.paths),
    };
  }

  run(
    args: readonly string[],
    options: {
      inherit?: boolean;
      composeFile?: string;
      input?: string;
      inputFile?: string;
      outputFile?: string;
      timeoutMs?: number;
    } = {}
  ): RunResult {
    const invocation = this.invocation(args, options.composeFile);
    return this.runner.run(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      inherit: options.inherit,
      input: options.input,
      inputFile: options.inputFile,
      outputFile: options.outputFile,
      timeoutMs: options.timeoutMs,
    });
  }

  runOrThrow(
    args: readonly string[],
    options: { inherit?: boolean; composeFile?: string; input?: string; inputFile?: string } = {}
  ): void {
    const result = this.run(args, options);
    if (result.status !== 0) {
      const exhausted = options.inherit
        ? args[0] === "up" && addressPoolsExhausted(this.runner)
        : `${result.stderr}${result.stdout}`.includes(ADDRESS_POOLS_EXHAUSTED);
      if (exhausted) throw new CliError(ADDRESS_POOLS_EXHAUSTED_ADVICE);
      throw new CliError(`Docker Compose failed: ${usefulFailure(result)}`);
    }
  }
}

export const requireComposeProject = (
  paths: InstallationPaths,
  runner: CommandRunner,
  projectName = PROJECT_NAME
): ComposeProject => {
  const compose = findCompose(runner);
  if (!compose) {
    throw new CliError(
      "Docker Compose is not available. Install Docker Desktop or the Docker Compose plugin first."
    );
  }
  if (!compose.supported) {
    throw new CliError(
      `OpenTeam requires Docker Compose ${MINIMUM_COMPOSE_VERSION} or newer; found ${compose.version || "an unknown version"}. Update Docker Desktop or the Compose plugin first.`
    );
  }
  return new ComposeProject(paths, compose, runner, projectName);
};
