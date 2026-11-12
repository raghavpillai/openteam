import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, readManifest, writeManifest } from "../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { isUpdateAgentProcess, runUpdateAgent } from "../src/update-agent";
import {
  installUpdateAgentService,
  launchAgent,
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

