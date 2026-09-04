import { describe, expect, test } from "bun:test";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  describePortOccupant,
  findPortConflict,
  foreignServerDetected,
  foreignServerMessage,
  portConflictMessage,
  portRequirementsFromEnvironment,
} from "../src/stack";

class DockerPsRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];

  constructor(private readonly publishers: Record<string, string> = {}) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    const filter = args.find((argument) => argument.startsWith("publish="));
    if (command === "docker" && args[0] === "ps" && filter) {
      const port = filter.slice("publish=".length);
      const line = this.publishers[port];
      return { status: 0, stdout: line ? `${line}\n` : "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

const withListener = async (run: (port: number) => Promise<void>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  try {
    if (!server.port) throw new Error("Expected Bun to allocate a port");
    await run(server.port);
  } finally {
    server.stop(true);
  }
};

describe("stack inspection", () => {
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
      "OpenTeam cannot start because port 8787 is already in use by another process on this machine. Stop the process that holds it, or choose another API port with openteam setup --advanced."
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
