import { VIEWER_PORT_END, VIEWER_PORT_START } from "./constants";
import { portAvailable, viewerPorts } from "./ports";
import type { ComposeProject } from "./docker";
import { CliError } from "./errors";
import type { HealthResult } from "./health";
import type { CommandRunner } from "./process";
import type { SetupConfiguration } from "./setup-values";

export interface PortOccupant {
  port: number;
  host: string;
  container?: string;
  project?: string;
}

export interface PortRequirements {
  apiHost: string;
  apiPort: number;
  viewerHost: string;
  https: boolean;
  /** Services whose published ports belong to this installation and need no check. */
  running: ReadonlySet<string>;
}

/** Compose services of this installation that are currently running. */
export const runningServices = (project: ComposeProject): Set<string> => {
  const result = project.run(["ps", "--status", "running", "--services"]);
  if (result.status !== 0) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
};

/** Ask Docker which container, if any, publishes a host port. */
export const describePortOccupant = (
  runner: CommandRunner,
  host: string,
  port: number
): PortOccupant => {
  const result = runner.run("docker", [
    "ps",
    "--filter",
    `publish=${port}`,
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  const line = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (!line) return { port, host };
  const [container, project] = line.split("\t");
  return {
    port,
    host,
    ...(container ? { container: container.trim() } : {}),
    ...(project?.trim() ? { project: project.trim() } : {}),
  };
};

const hostsToCheck = (host: string): string[] =>
  host === "127.0.0.1" ? [host] : Array.from(new Set([host, "127.0.0.1"]));

const firstOccupiedPort = async (
  runner: CommandRunner,
  host: string,
  ports: readonly number[]
): Promise<PortOccupant | null> => {
  for (const port of ports) {
    for (const candidate of hostsToCheck(host)) {
      if (!(await portAvailable(candidate, port))) {
        return describePortOccupant(runner, candidate, port);
      }
    }
  }
  return null;
};

export const portRequirementsFromEnvironment = (
  environment: ReadonlyMap<string, string>,
  running: ReadonlySet<string>
): PortRequirements => ({
  apiHost: environment.get("OPENTEAM_BIND_HOST") || "127.0.0.1",
  apiPort: Number(environment.get("OPENTEAM_API_PORT") || "8787"),
  viewerHost:
    environment.get("OPENTEAM_VIEWER_BIND_HOST") ||
    environment.get("OPENTEAM_BIND_HOST") ||
    "127.0.0.1",
  https: (environment.get("COMPOSE_PROFILES") || "").split(",").includes("https"),
  running,
});

export const portRequirementsFromConfiguration = (
  configuration: SetupConfiguration,
  running: ReadonlySet<string>
): PortRequirements => ({
  apiHost: configuration.bindHost,
  apiPort: Number(configuration.apiPort),
  viewerHost: configuration.viewerBindHost,
  https: configuration.accessMode === "https",
  running,
});

/**
 * Find the first port this installation needs that something else already holds.
 * Ports published by services that are already running belong to us and are skipped.
 */
export const findPortConflict = async (
  runner: CommandRunner,
  requirements: PortRequirements
): Promise<PortOccupant | null> => {
  const { running } = requirements;
  if (!running.has("server")) {
    const occupant = await firstOccupiedPort(runner, requirements.apiHost, [requirements.apiPort]);
    if (occupant) return occupant;
  }
  if (!running.has("computer")) {
    const occupant = await firstOccupiedPort(runner, requirements.viewerHost, viewerPorts());
    if (occupant) return occupant;
  }
  if (requirements.https && !running.has("caddy")) {
    const occupant = await firstOccupiedPort(runner, "0.0.0.0", [80, 443]);
    if (occupant) return occupant;
  }
  return null;
};

const holder = (occupant: PortOccupant): string =>
  occupant.container
    ? `container ${occupant.container}${occupant.project ? ` (Compose project ${occupant.project})` : ""}`
    : "another process on this machine";

const stopHint = (occupant: PortOccupant): string =>
  occupant.project
    ? `Stop that stack with \`docker compose -p ${occupant.project} down\``
    : occupant.container
      ? `Stop it with \`docker stop ${occupant.container}\``
      : "Stop the process that holds it";

export const portConflictMessage = (occupant: PortOccupant): string => {
  const port = occupant.port;
  const remedy =
    port === 80 || port === 443
      ? `${stopHint(occupant)}, or rerun setup and choose Existing HTTPS proxy.`
      : port >= VIEWER_PORT_START && port <= VIEWER_PORT_END
        ? `${stopHint(occupant)}; the screen-viewer range ${VIEWER_PORT_START}-${VIEWER_PORT_END} is fixed.`
        : `${stopHint(occupant)}, or choose another API port with openteam setup --advanced.`;
  return `OpenTeam cannot start because port ${port} is already in use by ${holder(occupant)}. ${remedy}`;
};

export const assertPortsAvailable = async (
  runner: CommandRunner,
  requirements: PortRequirements
): Promise<void> => {
  const occupant = await findPortConflict(runner, requirements);
  if (occupant) throw new CliError(portConflictMessage(occupant));
};

/** True when something answers the health check but this installation's server is not running. */
export const foreignServerDetected = (
  health: HealthResult,
  running: ReadonlySet<string>
): boolean => health.ok && !running.has("server");

export const foreignServerMessage = (
  runner: CommandRunner,
  health: HealthResult,
  environment: ReadonlyMap<string, string>
): string => {
  const port = Number(environment.get("OPENTEAM_API_PORT") || "8787");
  const occupant = describePortOccupant(runner, "127.0.0.1", port);
  const origin = health.url.replace(/\/api\/v0\/health$/, "");
  const who = occupant.container ? ` It is ${holder(occupant)}.` : "";
  const remedy = occupant.project
    ? `Stop that stack with \`docker compose -p ${occupant.project} down\`, or choose another API port with openteam setup --advanced.`
    : "Stop it, or choose another API port with openteam setup --advanced.";
  return `Another OpenTeam server is answering at ${origin}, but this installation's server is not running.${who} ${remedy}`;
};

export const assertOwnServer = (
  runner: CommandRunner,
  health: HealthResult,
  running: ReadonlySet<string>,
  environment: ReadonlyMap<string, string>
): void => {
  if (foreignServerDetected(health, running)) {
    throw new CliError(foreignServerMessage(runner, health, environment));
  }
};
