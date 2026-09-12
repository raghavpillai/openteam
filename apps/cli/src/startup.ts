import type { ComposeProject } from "./docker";
import type { InstallationPaths } from "./config";
import { CliError } from "./errors";
import { type HealthResult, waitForHealth } from "./health";

export const SETUP_JOBS_NOTE =
  'Storage setup and database migrations are one-time jobs. Docker shows them as "Exited" when finished; exit code 0 means success.';

interface ServiceState {
  Service: string;
  State: string;
  Health?: string;
  ExitCode?: number;
}

export const inspectStartupState = (
  project: ComposeProject,
  environment: ReadonlyMap<string, string>
): { stopped: boolean; notReady: string[] } => {
  const result = project.run(["ps", "--all", "--format", "json"], { timeoutMs: 5_000 });
  if (result.status !== 0) {
    throw new CliError(
      `Could not inspect OpenTeam services: ${result.stderr.trim() || result.error?.message || "Docker Compose service inspection failed"}`
    );
  }
  let services: ServiceState[];
  try {
    const output = result.stdout.trim();
    const rows: unknown[] = output.startsWith("[")
      ? JSON.parse(output)
      : output
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          !("Service" in row) ||
          typeof row.Service !== "string" ||
          !("State" in row) ||
          typeof row.State !== "string"
      )
    )
      throw new Error("invalid service state");
    services = rows as ServiceState[];
  } catch {
    throw new CliError(
      "Could not inspect OpenTeam services: Docker Compose returned invalid service state."
    );
  }
  const expected = ["postgres", "server", "worker", "computer"];
  if (
    (environment.get("COMPOSE_PROFILES") || "")
      .split(",")
      .some((profile) => profile.trim() === "https")
  ) {
    expected.push("caddy");
  }
  const notReady = expected.filter((name) => {
    const instances = services.filter((service) => service.Service === name);
    return (
      !instances.length ||
      instances.some(
        (service) => service.State !== "running" || (service.Health && service.Health !== "healthy")
      )
    );
  });
  for (const service of services) {
    if (
      (service.Service === "migrate" || service.Service.endsWith("-init")) &&
      (service.State !== "exited" || service.ExitCode !== 0)
    ) {
      notReady.push(service.Service);
    }
  }
  return {
    stopped: !services.some(
      (service) => expected.includes(service.Service) && service.State === "running"
    ),
    notReady: [...new Set(notReady)],
  };
};

/** A healthy container cannot repair a missing host listener by waiting longer. */
export const assertServerReachable = (project: ComposeProject, health: HealthResult): void => {
  if (!health.connectionFailed) return;
  const internal = project.run(
    [
      "exec",
      "--no-TTY",
      "server",
      "bun",
      "-e",
      'const r = await fetch("http://127.0.0.1:8787/api/v0/health", { signal: AbortSignal.timeout(3000) }); if (r.ok && (await r.json()).status === "ready") console.log("ready");',
    ],
    { timeoutMs: 5_000 }
  );
  if (internal.status === 0 && internal.stdout.trim() === "ready") {
    throw new CliError(
      `OpenTeam is ready inside Docker, but ${health.url} cannot be reached from this machine (${health.detail}). Check Docker's host port forwarding and other listeners on that port. With Colima, a Tailscale Serve listener can prevent forwarding even though Docker reports healthy containers; inspect it with \`tailscale serve status\`. Resolve the port conflict or repair Docker's forwarding, then retry openteam start.`
    );
  }
};

export const waitForStartup = (
  project: ComposeProject,
  paths: InstallationPaths,
  expectedVersion?: string
): Promise<HealthResult> =>
  waitForHealth(paths, 180_000, expectedVersion, (health, elapsedMs) => {
    // VM port forwarders need a short grace period after containers are recreated.
    if (elapsedMs >= 10_000) assertServerReachable(project, health);
  });
