import { existsSync } from "node:fs";
import type { InstallationPaths } from "./config";
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
  result.stderr.trim() || result.stdout.trim() || result.error?.message || "command failed";

export const dockerVersion = (runner: CommandRunner): RunResult =>
  runner.run("docker", ["--version"]);

export const dockerDaemon = (runner: CommandRunner): RunResult =>
  runner.run("docker", ["info", "--format", "{{.ServerVersion}}"]);

export const findCompose = (runner: CommandRunner): ComposeCommand | null => {
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
    return command("docker", ["compose"], plugin.stdout.trim());
  }
  const standalone = runner.run("docker-compose", ["version"]);
  if (standalone.status === 0) {
    return command("docker-compose", [], standalone.stdout.trim());
  }
  return null;
};

export class ComposeProject {
  constructor(
    readonly paths: InstallationPaths,
    readonly command: ComposeCommand,
    private readonly runner: CommandRunner,
    readonly projectName = PROJECT_NAME
  ) {}

  run(
    args: readonly string[],
    options: {
      inherit?: boolean;
      composeFile?: string;
      input?: string;
      inputFile?: string;
      outputFile?: string;
    } = {}
  ): RunResult {
    const composeFile = options.composeFile ?? this.paths.compose;
    if (!existsSync(composeFile)) throw new CliError(`Compose file not found: ${composeFile}`);
    return this.runner.run(
      this.command.executable,
      [
        ...this.command.prefix,
        "--project-name",
        this.projectName,
        "--project-directory",
        this.paths.directory,
        "--file",
        composeFile,
        ...args,
      ],
      {
        cwd: this.paths.directory,
        inherit: options.inherit,
        input: options.input,
        inputFile: options.inputFile,
        outputFile: options.outputFile,
      }
    );
  }

  runOrThrow(
    args: readonly string[],
    options: { inherit?: boolean; composeFile?: string; input?: string; inputFile?: string } = {}
  ): void {
    const result = this.run(args, options);
    if (result.status !== 0) {
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
      `OpenBot requires Docker Compose ${MINIMUM_COMPOSE_VERSION} or newer; found ${compose.version || "an unknown version"}. Update Docker Desktop or the Compose plugin first.`
    );
  }
  return new ComposeProject(paths, compose, runner, projectName);
};
