import { expect, test } from "bun:test";
import { type SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerUpdates } from "../../server/src/server-updates";
import { readManifest, writeManifest } from "../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  isUpdateAgentProcess,
  runUpdateAgent,
  stableRuntimePath,
  UPDATE_AGENT_ENV,
  UpdateAgent,
  updateAgentArguments,
} from "../src/update-agent";
import {
  installUpdateAgentService,
  launchAgent,
  type ServiceHost,
  systemdUnit,
  updateAgentService,
} from "../src/update-agent-service";
import { writeUpdateState } from "../src/update-safety";
import { installStack, scratch } from "./fixtures/harness";

const s = scratch();

/** An installation in a directory with a space, plus a fake home for service files. */
const installed = () => {
  const root = s.dir("openteam-update-agent-");
  const { paths } = installStack(join(root, "install dir"), {
    environment: "OPENTEAM_CONTROL_TOKEN=fixture-private-token\nOPENTEAM_API_PORT=9787\n",
  });
  return { root, paths, home: join(root, "home") };
};

const fixture = () => {
  const { root, paths } = installed();
  const updates = new ServerUpdates(join(root, "server-assets"), "1.2.3");
  const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:9787/api/v0/internal/system/update-agent");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-private-token");
    return Response.json(updates.heartbeat(JSON.parse(String(init?.body))));
  }) as typeof fetch;
  const launches: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const launch = ((_exe: string, args?: readonly string[], options?: SpawnOptions) => {
    launches.push({ args: args!, env: options!.env! });
    return new EventEmitter();
  }) as unknown as typeof spawn;
  return { paths, updates, request, launches, launch };
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

test("a Homebrew runtime starts the agent by a path that survives brew upgrade", () => {
  const prefix = s.dir("openteam-brew-");
  const versioned = join(prefix, "Cellar", "node@24", "24.13.1", "bin", "node");
  mkdirSync(join(versioned, ".."), { recursive: true });
  writeFileSync(versioned, "");
  mkdirSync(join(prefix, "opt"));
  symlinkSync(join("..", "Cellar", "node@24", "24.13.1"), join(prefix, "opt", "node@24"));
  // A keg-only formula isn't linked into bin; its opt link follows each upgrade.
  expect(stableRuntimePath(versioned, { PATH: "/usr/bin:/bin" })).toBe(
    join(prefix, "opt", "node@24", "bin", "node")
  );
});

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  constructor(private readonly respond: (command: string) => Partial<RunResult> = () => ({})) {}
  run(command: string, args: readonly string[], _options?: RunOptions): RunResult {
    const line = [command, ...args].join(" ");
    this.calls.push(line);
    return { status: 0, stdout: "", stderr: "", ...this.respond(line) };
  }
}

const host = (
  platform: NodeJS.Platform,
  home: string,
  runner: CommandRunner,
  overrides: Partial<ServiceHost> = {}
): ServiceHost => ({
  platform,
  uid: 501,
  home,
  environment: { HOME: home, USER: "owner" },
  runner,
  systemd: true,
  sleep: () => undefined,
  ...overrides,
});

const command = {
  executable: "/opt/open team/openteam",
  args: ["status", "--dir", "/srv/50% $HOME"],
  environment: { OPENTEAM_UPDATE_AGENT: "1", PATH: "/usr/bin:/bin" },
};

test("the systemd unit escapes its arguments and never stops an update the agent started", () => {
  const { paths } = installed();
  const unit = systemdUnit(paths, command);
  expect(unit).toContain('ExecStart="/opt/open team/openteam" "status" "--dir" "/srv/50%% $$HOME"');
  expect(unit).toContain('Environment="OPENTEAM_UPDATE_AGENT=1"');
  expect(unit).toContain(`\nWorkingDirectory=${paths.directory}\n`);
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=default.target");
});

test("the LaunchAgent starts at load, restarts only after a crash, and leaves updates running", () => {
  const { paths } = installed();
  const plist = launchAgent(paths, "so.openteam.update-agent", {
    ...command,
    args: ["status", "--dir", "/a&b<c>"],
  });
  expect(plist).toContain("<string>/a&amp;b&lt;c&gt;</string>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
});

test("launchd: bootstraps once, kickstarts a stopped agent, and never restarts a running one", () => {
  const { paths, home } = installed();
  const fresh = new FakeRunner((line) =>
    line.startsWith("launchctl print") ? { status: 113 } : {}
  );
  const service = updateAgentService(paths, host("darwin", home, fresh))!;
  expect(installUpdateAgentService(paths, command, false, host("darwin", home, fresh))).toEqual({
    managed: true,
  });
  expect(fresh.calls).toEqual([
    `launchctl print gui/501/${service.name}`,
    `launchctl bootstrap gui/501 ${service.file}`,
  ]);
  const loaded = new FakeRunner();
  installUpdateAgentService(paths, command, false, host("darwin", home, loaded));
  expect(loaded.calls).toEqual([
    `launchctl print gui/501/${service.name}`,
    `launchctl kickstart gui/501/${service.name}`,
  ]);
  const changed = { ...command, args: [...command.args, "--changed"] };
  const busy = new FakeRunner();
  installUpdateAgentService(paths, changed, true, host("darwin", home, busy));
  expect(busy.calls).toEqual([`launchctl print gui/501/${service.name}`]);
  expect(readFileSync(service.file, "utf8")).toContain("--changed");
  const failed = new FakeRunner((line) =>
    line.startsWith("launchctl print")
      ? { status: 113 }
      : { status: 5, stderr: "Input/output error" }
  );
  expect(installUpdateAgentService(paths, command, false, host("darwin", home, failed))).toEqual({
    managed: false,
    warning: "launchctl bootstrap failed: Input/output error",
  });
});

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(50);
  expect(condition()).toBe(true);
};

test("an agent starts after a reboot even when its old PID now belongs to another process", async () => {
  const { paths } = installed();
  const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const lock = join(paths.directory, "update-agent.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(unrelated.pid));
    expect(isUpdateAgentProcess(unrelated.pid!, paths.directory)).toBe(false);
    const agent = runUpdateAgent(paths);
    await waitFor(() => readFileSync(join(lock, "pid"), "utf8") === String(process.pid));
    expect(isUpdateAgentProcess(process.pid, paths.directory)).toBe(false);
    writeManifest(paths, { ...readManifest(paths)!, uninstalledAt: "now" });
    await agent;
    expect(existsSync(lock)).toBe(false);
  } finally {
    unrelated.kill();
  }
});
