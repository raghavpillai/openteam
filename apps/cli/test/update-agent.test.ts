import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions, spawn } from "node:child_process";
import { installationPaths, writeManifest } from "../src/config";
import {
  UpdateAgent,
  updateAgentArguments,
  updateAgentExecutable,
  UPDATE_AGENT_ENV,
  UPDATE_AGENT_CLI_ENV,
} from "../src/update-agent";
import { CLI_VERSION } from "../src/constants";
import { writeUpdateState } from "../src/update-safety";
import { ServerUpdates } from "../../server/src/server-updates";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-update-agent-"));
  directories.push(directory);
  const paths = installationPaths(directory);
  writeFileSync(
    paths.environment,
    "OPENTEAM_CONTROL_TOKEN=fixture-private-token\nOPENTEAM_API_PORT=9787\n"
  );
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "raghavpillai/openteam",
    version: "1.2.3",
    composeUrl: "https://example.invalid/compose.yaml",
    installedAt: "now",
    updatedAt: "now",
    ownerUsername: "owner",
  });
  const updates = new ServerUpdates(join(directory, "server-assets"), "1.2.3");
  let posts = 0;
  const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:9787/api/v0/internal/system/update-agent");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-private-token");
    posts++;
    return Response.json(updates.heartbeat(JSON.parse(String(init?.body))));
  }) as typeof fetch;
  const child = new EventEmitter();
  const launches: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const launch = ((_exe: string, args?: readonly string[], options?: SpawnOptions) => {
    launches.push({ args: args!, env: options!.env! });
    return child;
  }) as unknown as typeof spawn;
  return { paths, updates, request, child, launches, launch, posts: () => posts };
};

test("connected server request reaches only its own host updater, survives API restart, and completes", async () => {
  const f = fixture();
  const agent = new UpdateAgent(f.paths, f.request, f.launch);
  await agent.tick();
  expect(f.updates.view().updaterAvailable).toBe(true);
  f.updates.start({ targetVersion: "1.5.0" });
  await agent.tick();
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]!.args.slice(-5)).toEqual([
    "--dir",
    f.paths.directory,
    "--version",
    "1.5.0",
    "--json-progress",
  ]);
  expect(f.launches[0]!.env[UPDATE_AGENT_ENV]).toBeUndefined();
  expect(f.launches[0]!.env.OPENTEAM_UPDATE_WHEN_IDLE).toBe("1");
  await agent.tick();
  expect(f.launches).toHaveLength(1);
  writeUpdateState(f.paths, {
    schemaVersion: 1,
    jobId: "durable-host-job",
    workerPid: process.pid,
    status: "running",
    phase: "backing-up",
    fromVersion: "1.2.3",
    targetVersion: "1.5.0",
    message: "Database backup",
    startedAt: "now",
    updatedAt: "now",
  });
  await agent.tick();
  expect(f.updates.view()).toMatchObject({
    status: "updating",
    phase: "backing-up",
    jobId: "durable-host-job",
  });
  // A new host agent follows the existing durable job instead of spawning another update.
  const reconnected = new UpdateAgent(f.paths, f.request, f.launch);
  await reconnected.tick();
  expect(f.launches).toHaveLength(1);
  writeUpdateState(f.paths, {
    schemaVersion: 1,
    jobId: "durable-host-job",
    status: "complete",
    phase: "complete",
    fromVersion: "1.2.3",
    targetVersion: "1.5.0",
    message: "Updated",
    startedAt: "now",
    updatedAt: "now",
  });
  await reconnected.tick();
  expect(f.updates.view().status).toBe("updated");
});

test("never replays a claimed request after a crash before spawn", async () => {
  const f = fixture();
  const agent = new UpdateAgent(f.paths, f.request, f.launch);
  await agent.tick();
  f.updates.start({ targetVersion: "1.3.0" });
  await agent.tick();
  const restarted = new UpdateAgent(f.paths, f.request, f.launch);
  await restarted.tick();
  expect(f.launches).toHaveLength(1);
  expect(f.updates.view().status).toBe("error");
});

test("rejects unsafe versions again on the host and reports spawn failures", async () => {
  const f = fixture();
  await new UpdateAgent(f.paths, f.request, f.launch).tick();
  f.updates.start({ targetVersion: "1.3.0" });
  const request = f.updates.heartbeat({}).request!;
  for (const targetVersion of ["1.2.3", "1.0.0", "1.3.0-beta.1", "1.3.0; reboot"])
    expect(() => updateAgentArguments(f.paths, { ...request, targetVersion })).toThrow(
      "invalid update version"
    );
  const agent = new UpdateAgent(f.paths, f.request, (() => {
    throw new Error("Cannot launch updater");
  }) as typeof spawn);
  await agent.tick();
  await agent.tick();
  expect(f.updates.view()).toMatchObject({ status: "error", message: "Cannot launch updater" });
});

test("CLI daemon entrypoint authenticates to its installation without a desktop process", async () => {
  const f = fixture();
  let received!: () => void;
  const heartbeat = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/v0/internal/system/update-agent");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-private-token");
      f.updates.heartbeat({});
      received();
      return Response.json({ request: null });
    },
  });
  writeFileSync(
    f.paths.environment,
    `OPENTEAM_CONTROL_TOKEN=fixture-private-token\nOPENTEAM_API_PORT=${server.port}\n`
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../src/main.ts", import.meta.url).pathname,
      "status",
      "--dir",
      f.paths.directory,
    ],
    {
      env: { ...process.env, [UPDATE_AGENT_ENV]: "1" },
      stdout: "ignore",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => received(), 4_000);
  try {
    await heartbeat;
    expect(f.updates.view().updaterAvailable).toBe(true);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    server.stop(true);
  }
});

test("a staged CLI starts its daemon from the promoted installation, and private daemons invoke that CLI", () => {
  const target = "/tmp/openteam";
  const source = `/tmp/.openteam.update-${CLI_VERSION}-fixture`;
  expect(
    updateAgentExecutable(
      {
        OPENTEAM_CLI_UPDATE_SOURCE: source,
        OPENTEAM_CLI_UPDATE_TARGET: target,
        OPENTEAM_CLI_UPDATE_VERSION: CLI_VERSION,
      },
      source
    )
  ).toBe(target);
  expect(updateAgentExecutable({ [UPDATE_AGENT_CLI_ENV]: target }, "/tmp/private-agent")).toBe(
    target
  );
});
