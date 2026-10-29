import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, readManifest, writeManifest } from "../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  ensureUpdateAgent,
  isUpdateAgentProcess,
  runUpdateAgent,
  stopUpdateAgent,
} from "../src/update-agent";
import {
  installUpdateAgentService,
  launchAgent,
  removeUpdateAgentService,
  type ServiceHost,
  systemdUnit,
  updateAgentService,
} from "../src/update-agent-service";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "openteam-agent-service-"));
  directories.push(root);
  const paths = installationPaths(join(root, "install dir"));
  mkdirSync(paths.directory);
  writeFileSync(paths.environment, "OPENTEAM_CONTROL_TOKEN=t\nOPENTEAM_API_PORT=1\n");
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "raghavpillai/openteam",
    version: "1.2.3",
    composeUrl: "https://example.invalid/compose.yaml",
    installedAt: "now",
    updatedAt: "now",
    ownerUsername: "owner",
  });
  return { root, paths, home: join(root, "home") };
};

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

test("each installation gets its own service, and only where a service manager exists", () => {
  const { paths, home } = fixture();
  const runner = new FakeRunner();
  const mac = updateAgentService(paths, host("darwin", home, runner))!;
  expect(mac.name).toMatch(/^so\.openteam\.update-agent\.[0-9a-f]{10}$/);
  expect(mac.file).toBe(join(home, "Library", "LaunchAgents", `${mac.name}.plist`));
  const linux = updateAgentService(paths, host("linux", home, runner))!;
  expect(linux.name).toMatch(/^openteam-update-agent-[0-9a-f]{10}\.service$/);
  expect(linux.file).toBe(join(home, ".config", "systemd", "user", linux.name));
  const standard = installationPaths(join(home, ".openteam"));
  expect(updateAgentService(standard, host("linux", home, runner))!.name).toBe(
    "openteam-update-agent.service"
  );
  expect(updateAgentService(standard, host("darwin", home, runner))!.name).toBe(
    "so.openteam.update-agent"
  );
  expect(updateAgentService(paths, host("linux", home, runner, { systemd: false }))).toBeNull();
  expect(updateAgentService(paths, host("win32", home, runner))).toBeNull();
});

test("the systemd unit escapes its arguments and never stops an update the agent started", () => {
  const { paths } = fixture();
  const unit = systemdUnit(paths, command);
  expect(unit).toContain('ExecStart="/opt/open team/openteam" "status" "--dir" "/srv/50%% $$HOME"');
  expect(unit).toContain('Environment="OPENTEAM_UPDATE_AGENT=1"');
  expect(unit).toContain(`\nWorkingDirectory=${paths.directory}\n`);
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=default.target");
});

test("the LaunchAgent starts at load, restarts only after a crash, and leaves updates running", () => {
  const { paths } = fixture();
  const plist = launchAgent(paths, "so.openteam.update-agent", {
    ...command,
    args: ["status", "--dir", "/a&b<c>"],
  });
  expect(plist).toContain("<string>/a&amp;b&lt;c&gt;</string>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
});

test("systemd: enables linger and the unit, starting it only when no agent runs", () => {
  const { paths, home } = fixture();
  const runner = new FakeRunner((line) =>
    line.startsWith("loginctl show-user") ? { stdout: "no\n" } : {}
  );
  expect(installUpdateAgentService(paths, command, false, host("linux", home, runner))).toEqual({
    managed: true,
  });
  const service = updateAgentService(paths, host("linux", home, runner))!;
  expect(readFileSync(service.file, "utf8")).toBe(systemdUnit(paths, command));
  expect(runner.calls).toEqual([
    "loginctl show-user 501 --property=Linger --value",
    "loginctl enable-linger",
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${service.name}`,
  ]);
  // Unchanged unit and an agent already running: enable only, no reload, no second agent.
  const again = new FakeRunner((line) =>
    line.startsWith("loginctl show-user") ? { stdout: "yes\n" } : {}
  );
  installUpdateAgentService(paths, command, true, host("linux", home, again));
  expect(again.calls).toEqual([
    "loginctl show-user 501 --property=Linger --value",
    `systemctl --user enable ${service.name}`,
  ]);
});

test("systemd: explains how to start at boot when linger is not allowed, and falls back on failure", () => {
  const { paths, home } = fixture();
  const noLinger = new FakeRunner((line) =>
    line.startsWith("loginctl") ? { status: 1, stderr: "Access denied" } : {}
  );
  expect(installUpdateAgentService(paths, command, false, host("linux", home, noLinger))).toEqual({
    managed: true,
    linger: "sudo loginctl enable-linger owner",
  });
  rmSync(join(home, ".config"), { recursive: true });
  // Without linger or a sign-in session there is no user service manager to talk to.
  const noBus = new FakeRunner((line) =>
    line.startsWith("systemctl")
      ? { status: 1, stderr: "Failed to connect to bus: No such file or directory" }
      : { status: 1, stderr: "Could not enable linger: No such device or address" }
  );
  expect(installUpdateAgentService(paths, command, false, host("linux", home, noBus))).toEqual({
    managed: false,
    linger: "sudo loginctl enable-linger owner",
    warning:
      "systemctl --user daemon-reload failed: Failed to connect to bus: No such file or directory",
  });
});

test("launchd: bootstraps once, kickstarts a stopped agent, and never restarts a running one", () => {
  const { paths, home } = fixture();
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

test("removal stops the managed agent and deletes its registration", () => {
  const { paths, home } = fixture();
  const runner = new FakeRunner((line) =>
    line.startsWith("loginctl show-user") ? { stdout: "yes" } : {}
  );
  installUpdateAgentService(paths, command, false, host("linux", home, runner));
  const linux = updateAgentService(paths, host("linux", home, runner))!;
  runner.calls = [];
  expect(removeUpdateAgentService(paths, host("linux", home, runner))).toBe(true);
  expect(existsSync(linux.file)).toBe(false);
  expect(runner.calls).toEqual([
    `systemctl --user disable --now ${linux.name}`,
    "systemctl --user daemon-reload",
  ]);
  expect(removeUpdateAgentService(paths, host("linux", home, runner))).toBe(false);

  installUpdateAgentService(paths, command, false, host("darwin", home, runner));
  const mac = updateAgentService(paths, host("darwin", home, runner))!;
  runner.calls = [];
  expect(removeUpdateAgentService(paths, host("darwin", home, runner))).toBe(true);
  expect(existsSync(mac.file)).toBe(false);
  expect(runner.calls).toEqual([
    `launchctl print gui/501/${mac.name}`,
    `launchctl bootout gui/501/${mac.name}`,
  ]);
});

test("start registers the agent with the service manager instead of spawning a detached copy", () => {
  const { paths, home } = fixture();
  const runner = new FakeRunner((line) =>
    line.startsWith("loginctl show-user") ? { stdout: "yes" } : {}
  );
  const linux = host("linux", home, runner);
  ensureUpdateAgent(paths, linux);
  const service = updateAgentService(paths, linux)!;
  const unit = readFileSync(service.file, "utf8");
  expect(unit).toContain(`"status" "--dir" "${paths.directory}"`);
  expect(unit).toContain('Environment="OPENTEAM_UPDATE_AGENT=1"');
  expect(runner.calls.at(-1)).toBe(`systemctl --user enable --now ${service.name}`);
  // The service manager owns the agent: nothing was spawned to claim the lock.
  expect(existsSync(join(paths.directory, "update-agent.lock"))).toBe(false);
  stopUpdateAgent(paths, linux);
  expect(existsSync(service.file)).toBe(false);
});

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(50);
  expect(condition()).toBe(true);
};

test("an agent starts after a reboot even when its old PID now belongs to another process", async () => {
  const { paths } = fixture();
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

test("a claim left without a PID only holds off other agents briefly", async () => {
  const { paths } = fixture();
  const lock = join(paths.directory, "update-agent.lock");
  mkdirSync(lock);
  await runUpdateAgent(paths);
  expect(existsSync(join(lock, "pid"))).toBe(false);
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(lock, minuteAgo, minuteAgo);
  const agent = runUpdateAgent(paths);
  await waitFor(() => existsSync(join(lock, "pid")));
  writeManifest(paths, { ...readManifest(paths)!, uninstalledAt: "now" });
  await agent;
});
