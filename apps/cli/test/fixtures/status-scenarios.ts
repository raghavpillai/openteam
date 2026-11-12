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

// One scenario per distinct state the report must not mislabel.
export const statusScenarios = [
  ["healthy", "All containers healthy", "RUNNING", "openteam doctor"],
  ["setup-incomplete", "Account setup incomplete", "RUNNING", "openteam setup"],
  ["not-installed", "OpenTeam not installed", "NOT INSTALLED", "openteam install"],
  ["docker-stopped", "Docker engine unavailable", "STATUS UNKNOWN", "docker info"],
  ["stopped", "All containers stopped cleanly", "STOPPED", "Stopped · exit 0"],
  ["missing-worker", "Worker missing while server is ready", "NEEDS ATTENTION", "Not created"],
  ["unhealthy", "Worker health check failing", "NEEDS ATTENTION", "health check failing"],
  ["job-failed", "Database migration failed", "NEEDS ATTENTION", "openteam logs migrate"],
  ["health-version", "A different release answers", "NEEDS ATTENTION", "expected release 1.2.3"],
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
    if (command === "docker" && args[0] === "--version") return ok("Docker version 28.2.2");
    if (command === "docker" && args[0] === "info") {
      if (id === "docker-stopped")
        return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.");
      return ok("28.2.2");
    }
    if (args.includes("version")) return ok("Docker Compose version v5.1.3");
    if (args.includes("ps") && args.includes("json")) {
      const states: ServiceState[] = ["postgres", "server", "worker", "computer"].map(
        (Service) => ({ Service, State: "running", Health: "healthy" })
      );
      const worker = states[2]!;
      if (id === "stopped")
        for (const s of states) {
          s.State = "exited";
          s.Health = "";
          s.ExitCode = 0;
        }
      if (id === "missing-worker") states.splice(2, 1);
      if (id === "unhealthy") worker.Health = "unhealthy";
      if (id === "job-failed") states.push({ Service: "migrate", State: "exited", ExitCode: 1 });
      return ok(states.map((s) => JSON.stringify(s)).join("\n"));
    }
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
      const url = new URL(request.url);
      // The CLI is configured below to use 127.0.0.1. Local development-server
      // discovery also probes ephemeral ports using localhost; keep those
      // unrelated requests outside the read-only CLI request assertion.
      if (url.hostname !== "127.0.0.1") return new Response("Wrong fixture host", { status: 421 });
      requests.push(url.pathname);
      if (id === "stopped") return new Response("unavailable", { status: 503 });
      return Response.json({
        status: "ready",
        release: { releaseVersion: id === "health-version" ? "1.2.2" : "1.2.3" },
        runtime: { inference: "ready" },
      });
    },
  });
  const port = server.port;
  if (id !== "not-installed") {
    mkdirSync(paths.directory);
    const env = replaceEnvironmentValue(
      createEnvironment({ version: "1.2.3" }),
      "OPENTEAM_API_PORT",
      String(port)
    );
    writeFileSync(paths.environment, env, { mode: 0o600 });
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
