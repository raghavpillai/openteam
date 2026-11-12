import { describe, expect, spyOn, test } from "bun:test";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  findPortConflict,
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

});
