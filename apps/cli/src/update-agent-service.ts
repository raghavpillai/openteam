import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultInstallDirectory, type InstallationPaths, writeFileAtomic } from "./config";
import { type CommandRunner, SystemCommandRunner } from "./process";

/** The update agent's command line, as the CLI would spawn it. */
export interface UpdateAgentCommand {
  executable: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export interface ServiceHost {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  environment: NodeJS.ProcessEnv;
  runner: CommandRunner;
  /** True on a Linux host booted with systemd. */
  systemd: boolean;
  sleep(milliseconds: number): void;
}

export const systemServiceHost = (): ServiceHost => ({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  home: homedir(),
  environment: process.env,
  runner: new SystemCommandRunner(),
  systemd: existsSync("/run/systemd/system"),
  sleep: (milliseconds) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
});

export interface UpdateAgentService {
  kind: "systemd" | "launchd";
  name: string;
  file: string;
}

/** One service per installation directory, so isolated installs never share one. */
export const updateAgentService = (
  paths: InstallationPaths,
  host: ServiceHost
): UpdateAgentService | null => {
  const directory = resolve(paths.directory);
  const suffix =
    directory === defaultInstallDirectory(host.environment, host.platform, host.home)
      ? ""
      : `-${createHash("sha256").update(directory).digest("hex").slice(0, 10)}`;
  if (host.platform === "darwin") {
    const name = `so.openteam.update-agent${suffix.replace("-", ".")}`;
    return {
      kind: "launchd",
      name,
      file: join(host.home, "Library", "LaunchAgents", `${name}.plist`),
    };
  }
  if (host.platform === "linux" && host.systemd) {
    const name = `openteam-update-agent${suffix}.service`;
    const config = host.environment.XDG_CONFIG_HOME?.trim() || join(host.home, ".config");
    return { kind: "systemd", name, file: join(config, "systemd", "user", name) };
  }
  return null;
};

const systemdQuote = (value: string, command: boolean) =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, command ? "$$$$" : "$")}"`;

export const systemdUnit = (paths: InstallationPaths, command: UpdateAgentCommand): string =>
  [
    "[Unit]",
    `Description=OpenTeam server updater for ${paths.directory.replace(/%/g, "%%")}`,
    "",
    "[Service]",
    `ExecStart=${[command.executable, ...command.args].map((value) => systemdQuote(value, true)).join(" ")}`,
    ...Object.entries(command.environment).map(
      ([name, value]) => `Environment=${systemdQuote(`${name}=${value}`, false)}`
    ),
    // Unlike ExecStart and Environment, WorkingDirectory takes the path unquoted.
    `WorkingDirectory=${paths.directory.replace(/%/g, "%%")}`,
    "Restart=on-failure",
    "RestartSec=10",
    // Stopping the agent must never stop an update it started.
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const launchAgent = (
  paths: InstallationPaths,
  label: string,
  command: UpdateAgentCommand
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[command.executable, ...command.args].map((value) => `    <string>${xml(value)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(command.environment).map(
      ([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`
    ),
    "  </dict>",
    `  <key>WorkingDirectory</key><string>${xml(paths.directory)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    // Restart after a crash, but not when another agent already owns the installation.
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    // Stopping the agent must never stop an update it started.
    "  <key>AbandonProcessGroup</key><true/>",
    "  <key>ProcessType</key><string>Standard</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

const writeIfChanged = (file: string, contents: string): boolean => {
  try {
    if (readFileSync(file, "utf8") === contents) return false;
  } catch {
    // Missing: write it.
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, contents, 0o644);
  return true;
};

const failure = (result: { stderr: string; error?: Error }) =>
  result.stderr.trim() || result.error?.message || "unknown error";

const systemctl = (host: ServiceHost, args: readonly string[]) => {
  const env = {
    ...host.environment,
    XDG_RUNTIME_DIR: host.environment.XDG_RUNTIME_DIR || `/run/user/${host.uid}`,
  };
  // A user manager that linger just started can take a moment to accept connections.
  for (let attempt = 0; ; attempt++) {
    const result = host.runner.run("systemctl", ["--user", ...args], { env, timeoutMs: 30_000 });
    if (result.status === 0 || attempt >= 10 || !/connect to bus|No such file/i.test(result.stderr))
      return result;
    host.sleep(500);
  }
};

export interface ServiceSetup {
  managed: boolean;
  /** Why the service could not be registered. */
  warning?: string;
  /** Set when the user's services can't start at boot without signing in. */
  linger?: string;
}

/**
 * Register the update agent with the host's service manager so it starts again after a reboot
 * or sign-in. Starts it unless an agent is already running; the agent's own lock turns away any
 * duplicate.
 */
export const installUpdateAgentService = (
  paths: InstallationPaths,
  command: UpdateAgentCommand,
  agentRunning: boolean,
  host: ServiceHost = systemServiceHost()
): ServiceSetup => {
  const service = updateAgentService(paths, host);
  if (!service) return { managed: false };
  if (service.kind === "launchd") {
    const domain = `gui/${host.uid}`;
    const changed = writeIfChanged(service.file, launchAgent(paths, service.name, command));
    let loaded = host.runner.run("launchctl", ["print", `${domain}/${service.name}`]).status === 0;
    // A running agent keeps its definition; launchd reads the new one at the next sign-in.
    if (loaded && changed && !agentRunning) {
      host.runner.run("launchctl", ["bootout", `${domain}/${service.name}`]);
      loaded = false;
    }
    if (!loaded) {
      const result = host.runner.run("launchctl", ["bootstrap", domain, service.file]);
      if (result.status !== 0)
        return { managed: false, warning: `launchctl bootstrap failed: ${failure(result)}` };
    } else if (!agentRunning) {
      host.runner.run("launchctl", ["kickstart", `${domain}/${service.name}`]);
    }
    return { managed: true };
  }

  // Linger starts the user's service manager at boot instead of at their first sign-in.
  let linger: string | undefined;
  const lingering = host.runner.run("loginctl", [
    "show-user",
    String(host.uid),
    "--property=Linger",
    "--value",
  ]);
  if (lingering.stdout.trim() !== "yes") {
    const enabled = host.runner.run("loginctl", ["enable-linger"], { timeoutMs: 30_000 });
    if (enabled.status !== 0)
      linger = `sudo loginctl enable-linger ${host.environment.USER || host.environment.LOGNAME || host.uid}`;
  }
  if (writeIfChanged(service.file, systemdUnit(paths, command))) {
    const reload = systemctl(host, ["daemon-reload"]);
    if (reload.status !== 0)
      return {
        managed: false,
        linger,
        warning: `systemctl --user daemon-reload failed: ${failure(reload)}`,
      };
  }
  const enable = systemctl(
    host,
    agentRunning ? ["enable", service.name] : ["enable", "--now", service.name]
  );
  if (enable.status !== 0)
    return {
      managed: false,
      linger,
      warning: `systemctl --user enable failed: ${failure(enable)}`,
    };
  return { managed: true, linger };
};

/** Stop the service-managed agent and remove its registration. Returns whether one existed. */
export const removeUpdateAgentService = (
  paths: InstallationPaths,
  host: ServiceHost = systemServiceHost()
): boolean => {
  const service = updateAgentService(paths, host);
  if (!service) return false;
  if (service.kind === "launchd") {
    const target = `gui/${host.uid}/${service.name}`;
    const loaded = host.runner.run("launchctl", ["print", target]).status === 0;
    if (loaded) host.runner.run("launchctl", ["bootout", target]);
    if (!existsSync(service.file)) return loaded;
    rmSync(service.file, { force: true });
    return true;
  }
  if (!existsSync(service.file)) return false;
  systemctl(host, ["disable", "--now", service.name]);
  rmSync(service.file, { force: true });
  systemctl(host, ["daemon-reload"]);
  return true;
};
