import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { installationPaths, writeFileAtomic } from "../src/config";
import { checkHealth, healthUrl } from "../src/health";
import * as ports from "../src/ports";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  findPortConflict,
  portConflictMessage,
  portRequirementsFromEnvironment,
} from "../src/stack";
import { assertServerReachable, inspectStartupState } from "../src/startup";
import { composeProject, scratch } from "./fixtures/harness";

const s = scratch();

describe("installation health URL", () => {
  test("uses loopback to inspect a service bound to every interface", () => {
    const paths = installationPaths(s.dir("openteam-cli-health-"));
    writeFileAtomic(paths.environment, "OPENTEAM_BIND_HOST=0.0.0.0\nOPENTEAM_API_PORT=9444\n");
    expect(healthUrl(paths)).toBe("http://127.0.0.1:9444/api/v0/health");
  });

  test("requires ready status and the exact target release", async () => {
    const paths = installationPaths(s.dir("openteam-cli-health-"));
    let status = "degraded";
    let version = "1.2.3";
    const server = s.serve(() => Response.json({ status, release: { releaseVersion: version } }));
    writeFileAtomic(paths.environment, `OPENTEAM_API_PORT=${server.port}\n`);

    expect((await checkHealth(paths)).detail).toBe("runtime is degraded");
    status = "ready";
    expect((await checkHealth(paths, "1.3.0")).detail).toContain("1.2.3 is responding");
    version = "1.3.0";
    expect(await checkHealth(paths, "1.3.0")).toMatchObject({ ok: true, version: "1.3.0" });
  });
});

describe("startup forwarding diagnosis", () => {
  test("requires the bundled HTTPS proxy only when its profile is enabled", () => {
    const paths = installationPaths(s.dir("openteam-cli-startup-"));
    writeFileSync(paths.compose, "services: {}\n");
    const services = ["postgres", "server", "worker", "computer"].map((Service) => ({
      Service,
      State: "running",
      Health: "healthy",
    }));
    const runner: CommandRunner = {
      run: () => ({ status: 0, stdout: JSON.stringify(services), stderr: "" }),
    };
    const project = composeProject(paths, runner);
    expect(inspectStartupState(project, new Map())).toEqual({ stopped: false, notReady: [] });
    const environment = new Map([["COMPOSE_PROFILES", "https"]]);
    expect(inspectStartupState(project, environment)).toEqual({
      stopped: false,
      notReady: ["caddy"],
    });
    services.push({ Service: "caddy", State: "running", Health: "" });
    expect(inspectStartupState(project, environment)).toEqual({ stopped: false, notReady: [] });
    services.push({ Service: "worker", State: "running", Health: "unhealthy" });
    expect(inspectStartupState(project, environment).notReady).toEqual(["worker"]);
  });

  test("requires evidence of both a failed host connection and a ready container", () => {
    const paths = installationPaths(s.dir("openteam-cli-startup-"));
    writeFileSync(paths.compose, "services: {}\n");
    const calls: RunOptions[] = [];
    let result: RunResult = { status: 0, stdout: "ready\n", stderr: "" };
    const runner: CommandRunner = {
      run(_command, _args, options) {
        calls.push(options ?? {});
        return result;
      },
    };
    const project = composeProject(paths, runner);
    const health = {
      ok: false,
      url: "http://127.0.0.1:8787/api/v0/health",
      detail: "fetch failed (ECONNREFUSED)",
      connectionFailed: true,
    };
    expect(() =>
      assertServerReachable(project, { ...health, connectionFailed: false, detail: "HTTP 503" })
    ).not.toThrow();
    expect(calls).toHaveLength(0);
    expect(() => assertServerReachable(project, health)).toThrow("ready inside Docker");
    expect(calls.at(-1)?.timeoutMs).toBe(5_000);
    for (const failure of [
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "container is starting" },
      { status: 1, stdout: "", stderr: "timed out" },
    ]) {
      result = failure;
      expect(() => assertServerReachable(project, health)).not.toThrow();
    }
  });
});

class DockerPsRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: RunOptions;
  }> = [];
  tailscale: RunResult = { status: 1, stdout: "", stderr: "not installed" };

  constructor(private readonly publishers: Record<string, string> = {}) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "tailscale") return this.tailscale;
    const filter = args.find((argument) => argument.startsWith("publish="));
    if (command === "docker" && args[0] === "ps" && filter) {
      const port = filter.slice("publish=".length);
      const line = this.publishers[port];
      return { status: 0, stdout: line ? `${line}\n` : "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

const withListener = async (run: (port: number) => Promise<void>, hostname = "127.0.0.1") => {
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    if (!server.port) throw new Error("Expected Bun to allocate a port");
    await run(server.port);
  } finally {
    server.stop(true);
  }
};

describe("stack inspection", () => {
  test("detects a Tailscale API listener even when Docker claims the server is running", async () => {
    const runner = new DockerPsRunner({
      "8787": "openteam-server-1\topenteam",
    });
    runner.tailscale = {
      status: 0,
      stdout: JSON.stringify({
        TCP: { "8787": { TCPForward: "127.0.0.1:8787" } },
      }),
      stderr: "",
    };
    const conflict = await findPortConflict(
      runner,
      portRequirementsFromEnvironment(
        new Map([["OPENTEAM_BIND_HOST", "0.0.0.0"]]),
        new Set(["server", "computer"])
      )
    );
    expect(conflict).toEqual({ port: 8787, host: "0.0.0.0", tailscale: true });
    expect(portConflictMessage(conflict!)).toContain("Tailscale Serve already uses port 8787");
    expect(portConflictMessage(conflict!)).toContain("tailscale serve status");
    expect(portConflictMessage(conflict!)).not.toContain("docker compose -p openteam down");
    expect(runner.calls.find((call) => call.command === "tailscale")?.options?.timeoutMs).toBe(
      3_000
    );
  });

  test("reports an occupied API port unless this installation's server already holds it", async () => {
    await withListener(async (port) => {
      const runner = new DockerPsRunner({
        [String(port)]: "openteam-dev-server-1\topenteam-dev",
      });
      const environment = new Map([
        ["OPENTEAM_BIND_HOST", "0.0.0.0"],
        ["OPENTEAM_API_PORT", String(port)],
      ]);

      const conflict = await findPortConflict(
        runner,
        portRequirementsFromEnvironment(environment, new Set(["postgres", "computer"]))
      );
      expect(conflict).toMatchObject({
        port,
        container: "openteam-dev-server-1",
      });

      expect(
        await findPortConflict(
          runner,
          portRequirementsFromEnvironment(environment, new Set(["server", "computer"]))
        )
      ).toBeNull();
      expect(
        await findPortConflict(runner, {
          ...portRequirementsFromEnvironment(environment, new Set(["server", "computer", "caddy"])),
          https: true,
        })
      ).toBeNull();
    });
  });

  test("probes the wildcard address where a loopback bind can succeed beside it", () => {
    expect(ports.probeHosts("127.0.0.1", "darwin")).toEqual(["127.0.0.1", "0.0.0.0"]);
    expect(ports.probeHosts("100.64.0.1", "darwin")).toEqual([
      "100.64.0.1",
      "127.0.0.1",
      "0.0.0.0",
    ]);
    expect(ports.probeHosts("0.0.0.0", "darwin")).toEqual(["0.0.0.0", "127.0.0.1"]);
    expect(ports.probeHosts("127.0.0.1", "win32")).toEqual(["127.0.0.1", "0.0.0.0"]);
    // Linux refuses the loopback bind itself, so a wildcard probe would only add false conflicts.
    expect(ports.probeHosts("127.0.0.1", "linux")).toEqual(["127.0.0.1"]);
  });

  test("reports a loopback port that another container publishes on every address", async () => {
    await withListener(async (port) => {
      const runner = new DockerPsRunner({
        [String(port)]: "other-computer-1\tother",
      });
      const conflict = await findPortConflict(
        runner,
        portRequirementsFromEnvironment(
          new Map([["OPENTEAM_API_PORT", String(port)]]),
          new Set(["computer"])
        )
      );
      expect(conflict).toMatchObject({
        port,
        container: "other-computer-1",
        project: "other",
      });
      expect(portConflictMessage(conflict!)).toContain(
        `port ${port} is already in use by container other-computer-1 (Compose project other). Stop that stack with \`docker compose -p other down\``
      );
      expect(await ports.firstUnavailablePort("127.0.0.1", [port])).toBe(port);
      expect(await ports.suggestApiPort("127.0.0.1", port)).not.toBe(port);
    }, "0.0.0.0");
  });
});
