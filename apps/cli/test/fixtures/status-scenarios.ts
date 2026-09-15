import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  replaceEnvironmentValue,
  writeManifest,
} from "../../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../../src/process";
import type { ServiceState } from "../../src/startup";
import type { StatusReport } from "../../src/status-ui";

export const statusScenarios = [
  ["healthy", "All containers healthy", "RUNNING", "openteam doctor"],
  ["live-ready", "Live dependencies healthy", "RUNNING", "Queue database"],
  ["database-unavailable", "Database is unreachable", "NEEDS ATTENTION", "database: unavailable"],
  [
    "queue-unavailable",
    "Application queue schema missing",
    "NEEDS ATTENTION",
    "queue: unavailable",
  ],
  [
    "computer-unavailable",
    "Computer API authentication rejected",
    "NEEDS ATTENTION",
    "computer: unavailable",
  ],
  ["no-healthcheck", "Running without a Docker health check", "RUNNING", "no Docker health check"],
  [
    "provider-missing",
    "Server ready; model provider not connected",
    "RUNNING",
    "openteam provider list",
  ],
  ["setup-incomplete", "Account setup incomplete", "RUNNING", "openteam setup"],
  ["not-installed", "OpenTeam not installed", "NOT INSTALLED", "openteam install"],
  ["partial-install", "Missing installation files", "STATUS UNKNOWN", "known-good backup"],
  [
    "invalid-manifest",
    "Damaged installation manifest",
    "STATUS UNKNOWN",
    "configuration could not be read",
  ],
  ["docker-missing", "Docker command missing", "STATUS UNKNOWN", "docker command was not found"],
  ["docker-stopped", "Docker engine unavailable", "STATUS UNKNOWN", "docker info"],
  ["docker-permission", "Docker socket access denied", "STATUS UNKNOWN", "your user has access"],
  ["docker-timeout", "Docker engine check timed out", "STATUS UNKNOWN", "timed out"],
  ["compose-missing", "Docker Compose missing", "STATUS UNKNOWN", "2.20.0 or newer"],
  ["compose-old", "Docker Compose too old", "STATUS UNKNOWN", "2.20.0 or newer"],
  ["compose-fallback", "Standalone Compose fallback", "RUNNING", "4/4 containers running"],
  [
    "inspection-failed",
    "Docker cannot inspect containers",
    "STATUS UNKNOWN",
    "could not read its container states",
  ],
  [
    "invalid-json",
    "Docker returns malformed container output",
    "STATUS UNKNOWN",
    "invalid service state",
  ],
  [
    "invalid-health",
    "Docker returns an invalid health field",
    "STATUS UNKNOWN",
    "invalid service state",
  ],
  [
    "invalid-exit",
    "Docker returns an invalid exit code",
    "STATUS UNKNOWN",
    "invalid service state",
  ],
  ["no-containers", "No containers created", "STOPPED", "openteam start"],
  ["stopped", "All containers stopped cleanly", "STOPPED", "Stopped · exit 0"],
  ["missing-worker", "Worker missing while server is ready", "NEEDS ATTENTION", "Not created"],
  ["missing-caddy", "HTTPS proxy missing", "NEEDS ATTENTION", "caddy"],
  ["starting", "Container health checks starting", "STARTING", "Wait a moment"],
  ["restarting", "Worker restart loop", "NEEDS ATTENTION", "openteam logs worker"],
  ["unhealthy", "Worker health check failing", "NEEDS ATTENTION", "health check failing"],
  ["paused", "Worker paused", "NEEDS ATTENTION", "Paused"],
  ["dead", "Worker dead", "NEEDS ATTENTION", "Dead"],
  ["exited", "Worker exited with an error", "NEEDS ATTENTION", "exit 137"],
  ["replica-failed", "One worker replica stopped", "NEEDS ATTENTION", "worker (2/2)"],
  ["job-complete", "Successful setup jobs", "RUNNING", "Completed · exit 0"],
  ["job-failed", "Database migration failed", "NEEDS ATTENTION", "openteam logs migrate"],
  ["job-running", "Database migration in progress", "STARTING", "setup in progress"],
  ["health-503", "Server readiness returns HTTP 503", "NEEDS ATTENTION", "HTTP 503"],
  [
    "health-invalid",
    "Server returns an unexpected response",
    "NEEDS ATTENTION",
    "readiness is unknown",
  ],
  ["health-version", "A different release answers", "NEEDS ATTENTION", "expected release 1.2.3"],
  [
    "health-unreachable",
    "Server port cannot be reached",
    "NEEDS ATTENTION",
    "Cannot reach the server",
  ],
  [
    "foreign-server",
    "Another installation answers on this port",
    "NEEDS ATTENTION",
    "Another OpenTeam server",
  ],
] as const;
export type StatusScenarioId = (typeof statusScenarios)[number][0];

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

export class StatusScenarioRunner implements CommandRunner {
  calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  constructor(readonly id: StatusScenarioId) {}
  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    const id = this.id;
    if (command === "docker" && args[0] === "--version")
      return id === "docker-missing"
        ? {
            ...fail(""),
            error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
          }
        : ok("Docker version 28.2.2");
    if (command === "docker" && args[0] === "info") {
      if (id === "docker-stopped")
        return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.");
      if (id === "docker-permission")
        return fail("permission denied while trying to connect to the Docker daemon socket");
      if (id === "docker-timeout")
        return {
          ...fail(""),
          error: Object.assign(new Error("check timed out"), { code: "ETIMEDOUT" }),
        };
      return ok("28.2.2");
    }
    if (args.includes("version")) {
      if (id === "compose-missing" || (id === "compose-fallback" && command === "docker"))
        return fail("compose is unavailable");
      return ok(
        id === "compose-old" ? "Docker Compose version v1.29.2" : "Docker Compose version v5.1.3"
      );
    }
    if (args.includes("ps") && args.includes("json")) {
      if (id === "inspection-failed") return fail("yaml: line 8: did not find expected key");
      if (id === "invalid-json") return ok("{broken");
      const states: ServiceState[] = ["postgres", "server", "worker", "computer"].map(
        (Service) => ({ Service, State: "running", Health: "healthy" })
      );
      const worker = states[2]!;
      if (id === "no-containers" || id === "foreign-server") return ok("[]");
      if (id === "stopped")
        for (const s of states) {
          s.State = "exited";
          s.Health = "";
          s.ExitCode = 0;
        }
      if (id === "missing-worker") states.splice(2, 1);
      if (id === "no-healthcheck") delete worker.Health;
      if (id === "starting") worker.Health = "starting";
      if (id === "unhealthy") worker.Health = "unhealthy";
      if (["restarting", "paused", "dead", "exited"].includes(id)) {
        worker.State = id;
        worker.Health = "";
        worker.ExitCode = id === "exited" ? 137 : 1;
      }
      if (id === "replica-failed") states.push({ Service: "worker", State: "exited", ExitCode: 1 });
      if (id.startsWith("job-"))
        states.push({
          Service: "migrate",
          State: id === "job-running" ? "running" : "exited",
          ExitCode: id === "job-failed" ? 1 : 0,
        });
      if (id === "invalid-health")
        return ok(JSON.stringify([{ Service: "worker", State: "running", Health: false }]));
      if (id === "invalid-exit")
        return ok(JSON.stringify([{ Service: "worker", State: "exited", ExitCode: "0" }]));
      return ok(states.map((s) => JSON.stringify(s)).join("\n"));
    }
    if (command === "docker" && args[0] === "ps") return ok("other-server-1\tother-project");
    throw new Error(`Unexpected command in read-only status: ${command} ${args.join(" ")}`);
  }
}

export const statusFixture = (id: StatusScenarioId) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-status-"));
  const paths = installationPaths(join(directory, "installation's space"));
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      if (["stopped", "no-containers", "health-503"].includes(id))
        return new Response("unavailable", { status: 503 });
      if (id === "health-invalid") return new Response("<html>wrong server</html>");
      if (id === "live-ready" || id.endsWith("-unavailable"))
        return Response.json(
          {
            status: id === "live-ready" ? "ready" : "degraded",
            release: { releaseVersion: "1.2.3" },
            runtime: Object.fromEntries(
              ["database", "queue", "computer", "inference"].map((name) => [
                name,
                id === `${name}-unavailable` ? "unavailable" : "ready",
              ])
            ),
          },
          { status: id === "live-ready" ? 200 : 503 }
        );
      return Response.json({
        status: "ready",
        release: { releaseVersion: id === "health-version" ? "1.2.2" : "1.2.3" },
        runtime: { inference: id === "provider-missing" ? "missing" : "ready" },
      });
    },
  });
  const port = server.port;
  if (id === "health-unreachable") server.stop(true);
  if (id !== "not-installed") {
    mkdirSync(paths.directory);
    let env = replaceEnvironmentValue(
      createEnvironment({ version: "1.2.3" }),
      "OPENTEAM_API_PORT",
      String(port)
    );
    if (id === "missing-caddy") env = replaceEnvironmentValue(env, "COMPOSE_PROFILES", "https");
    writeFileSync(paths.environment, env, { mode: 0o600 });
    if (id !== "partial-install")
      writeFileSync(paths.compose, "services:\n  server:\n    image: example/server\n");
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "example/team",
      version: "1.2.3",
      composeUrl: "https://example.test/compose.yaml",
      installedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      projectName: "friend-team",
      ownerUsername: id === "setup-incomplete" ? undefined : "owner",
    });
    if (id === "invalid-manifest") writeFileSync(paths.manifest, "{broken");
  }
  const before = [paths.manifest, paths.environment, paths.compose].flatMap((file) => {
    try {
      return [[file, readFileSync(file, "utf8")] as const];
    } catch {
      return [];
    }
  });
  return {
    directory,
    paths,
    port,
    requests,
    before,
    runner: new StatusScenarioRunner(id),
    cleanup() {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

/** Keep temporary paths, ephemeral ports, and shell quoting stable in exported previews. */
export const normalizeStatusPreview = (
  report: StatusReport,
  fixture: ReturnType<typeof statusFixture>
): StatusReport => {
  const directory = "/tmp/status-preview/installation's space";
  const quote = (value: string, windows = false) => value.replace(/'/g, windows ? "''" : "'\\''");
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === "string"
        ? value
            .replaceAll(
              quote(fixture.paths.directory, process.platform === "win32"),
              quote(directory)
            )
            .replaceAll(fixture.paths.directory, directory)
            .replaceAll(fixture.directory, "/tmp/status-preview")
            .replaceAll(`:${fixture.port}`, ":8787")
        : value
    )
  );
};
