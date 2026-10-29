import { describe, expect, spyOn, test } from "bun:test";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  describePortOccupant,
  findPortConflict,
  foreignServerDetected,
  foreignServerMessage,
  portConflictMessage,
  portRequirementsFromEnvironment,
} from "../src/stack";
import * as ports from "../src/ports";

class DockerPsRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
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
  const server = Bun.serve({ hostname, port: 0, fetch: () => new Response("ok") });
  try {
    if (!server.port) throw new Error("Expected Bun to allocate a port");
    await run(server.port);
  } finally {
    server.stop(true);
  }
};

describe("stack inspection", () => {
  test("detects a Tailscale API listener even when Docker claims the server is running", async () => {
    const runner = new DockerPsRunner({ "8787": "openteam-server-1\topenteam" });
    runner.tailscale = {
      status: 0,
      stdout: JSON.stringify({ TCP: { "8787": { TCPForward: "127.0.0.1:8787" } } }),
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

  test("allows a loopback server behind Tailscale Serve", async () => {
    const runner = new DockerPsRunner();
    runner.tailscale = {
      status: 0,
      stdout: JSON.stringify({ TCP: { "8787": { TCPForward: "127.0.0.1:8787" } } }),
      stderr: "",
    };
    expect(
      await findPortConflict(
        runner,
        portRequirementsFromEnvironment(new Map(), new Set(["server", "computer"]))
      )
    ).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  test("detects foreground Tailscale listeners on viewer and HTTPS ports", async () => {
    const runner = new DockerPsRunner();
    runner.tailscale = {
      status: 0,
      stdout: JSON.stringify({
        Foreground: { session: { TCP: { "6205": {}, "443": { HTTPS: true } } } },
      }),
      stderr: "",
    };
    const requirements = portRequirementsFromEnvironment(
      new Map([["OPENTEAM_VIEWER_BIND_HOST", "0.0.0.0"]]),
      new Set(["server", "computer", "caddy"])
    );
    expect(await findPortConflict(runner, requirements)).toMatchObject({
      port: 6205,
      tailscale: true,
    });
    expect(
      await findPortConflict(runner, { ...requirements, viewerHost: "127.0.0.1", https: true })
    ).toMatchObject({ port: 443, tailscale: true });
  });

  test("ignores unrelated rules, service VIPs, and unavailable or invalid Tailscale output", async () => {
    const runner = new DockerPsRunner();
    const requirements = portRequirementsFromEnvironment(
      new Map([["OPENTEAM_BIND_HOST", "0.0.0.0"]]),
      new Set(["server", "computer"])
    );
    for (const result of [
      { status: 1, stdout: "", stderr: "daemon unavailable" },
      { status: 0, stdout: "not JSON", stderr: "" },
      { status: 0, stdout: "null", stderr: "" },
      {
        status: 0,
        stdout: JSON.stringify({
          TCP: { "10000": { HTTPS: true } },
          Services: { example: { TCP: { "8787": {} } } },
        }),
        stderr: "",
      },
    ]) {
      runner.tailscale = result;
      expect(await findPortConflict(runner, requirements)).toBeNull();
    }
  });

  test("names the container and Compose project that publish a port", () => {
    const runner = new DockerPsRunner({ "6200": "openteam-dev-computer-1\topenteam-dev" });
    expect(describePortOccupant(runner, "127.0.0.1", 6200)).toEqual({
      port: 6200,
      host: "127.0.0.1",
      container: "openteam-dev-computer-1",
      project: "openteam-dev",
    });
    expect(describePortOccupant(runner, "127.0.0.1", 8787)).toEqual({
      port: 8787,
      host: "127.0.0.1",
    });
  });

  test("reports an occupied API port unless this installation's server already holds it", async () => {
    await withListener(async (port) => {
      const runner = new DockerPsRunner({ [String(port)]: "openteam-dev-server-1\topenteam-dev" });
      const environment = new Map([
        ["OPENTEAM_BIND_HOST", "0.0.0.0"],
        ["OPENTEAM_API_PORT", String(port)],
      ]);

      const conflict = await findPortConflict(
        runner,
        portRequirementsFromEnvironment(environment, new Set(["postgres", "computer"]))
      );
      expect(conflict).toMatchObject({ port, container: "openteam-dev-server-1" });

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
    expect(ports.probeHosts("100.64.0.1", "darwin")).toEqual(["100.64.0.1", "127.0.0.1", "0.0.0.0"]);
    expect(ports.probeHosts("0.0.0.0", "darwin")).toEqual(["0.0.0.0", "127.0.0.1"]);
    expect(ports.probeHosts("127.0.0.1", "win32")).toEqual(["127.0.0.1", "0.0.0.0"]);
    // Linux refuses the loopback bind itself, so a wildcard probe would only add false conflicts.
    expect(ports.probeHosts("127.0.0.1", "linux")).toEqual(["127.0.0.1"]);
  });

  test("reports a loopback port that another container publishes on every address", async () => {
    await withListener(async (port) => {
      const runner = new DockerPsRunner({ [String(port)]: "other-computer-1\tother" });
      const conflict = await findPortConflict(
        runner,
        portRequirementsFromEnvironment(
          new Map([["OPENTEAM_API_PORT", String(port)]]),
          new Set(["computer"])
        )
      );
      expect(conflict).toMatchObject({ port, container: "other-computer-1", project: "other" });
      expect(portConflictMessage(conflict!)).toContain(
        `port ${port} is already in use by container other-computer-1 (Compose project other). Stop that stack with \`docker compose -p other down\``
      );
      expect(await ports.firstUnavailablePort("127.0.0.1", [port])).toBe(port);
      expect(await ports.suggestApiPort("127.0.0.1", port)).not.toBe(port);
    }, "0.0.0.0");
  });

  test("checks every probed address for each viewer port", async () => {
    const probed: string[] = [];
    const available = spyOn(ports, "portAvailable").mockImplementation(async (host, port) => {
      probed.push(`${host}:${port}`);
      return !(host === "0.0.0.0" && port === 6201);
    });
    try {
      const conflict = await findPortConflict(new DockerPsRunner(), {
        ...portRequirementsFromEnvironment(new Map(), new Set(["server"])),
      });
      if (process.platform === "linux") {
        expect(conflict).toBeNull();
      } else {
        expect(conflict).toEqual({ port: 6201, host: "0.0.0.0" });
        expect(probed).toEqual(["127.0.0.1:6200", "0.0.0.0:6200", "127.0.0.1:6201", "0.0.0.0:6201"]);
      }
    } finally {
      available.mockRestore();
    }
  });

  test("explains each kind of conflict with a stop command", () => {
    expect(
      portConflictMessage({
        port: 6200,
        host: "127.0.0.1",
        container: "openteam-dev-computer-1",
        project: "openteam-dev",
      })
    ).toBe(
      "OpenTeam cannot start because port 6200 is already in use by container openteam-dev-computer-1 (Compose project openteam-dev). Stop that stack with `docker compose -p openteam-dev down`; the screen-viewer range 6200-6299 is fixed."
    );
    expect(portConflictMessage({ port: 8787, host: "127.0.0.1" })).toBe(
      "OpenTeam cannot start because port 8787 is already in use by another process on this machine. Find it with `lsof -nP -iTCP:8787 -sTCP:LISTEN` and stop it, or choose another API port with openteam setup --advanced."
    );
    expect(portConflictMessage({ port: 443, host: "0.0.0.0", container: "nginx" })).toBe(
      "OpenTeam cannot start because port 443 is already in use by container nginx. Stop it with `docker stop nginx`, or rerun setup and choose Existing HTTPS proxy."
    );
  });

  test("recognises a healthy answer from a server this installation is not running", () => {
    const health = { ok: true, url: "http://127.0.0.1:8787/api/v0/health", detail: "ready" };
    expect(foreignServerDetected(health, new Set(["postgres"]))).toBe(true);
    expect(foreignServerDetected(health, new Set(["postgres", "server"]))).toBe(false);
    expect(foreignServerDetected({ ...health, ok: false }, new Set())).toBe(false);

    const runner = new DockerPsRunner({ "8787": "openteam-dev-server-1\topenteam-dev" });
    expect(foreignServerMessage(runner, health, new Map([["OPENTEAM_API_PORT", "8787"]]))).toBe(
      "Another OpenTeam server is answering at http://127.0.0.1:8787, but this installation's server is not running. It is container openteam-dev-server-1 (Compose project openteam-dev). Stop that stack with `docker compose -p openteam-dev down`, or choose another API port with openteam setup --advanced."
    );
    expect(foreignServerMessage(new DockerPsRunner(), health, new Map())).toContain(
      "Stop it, or choose another API port"
    );
  });
});
