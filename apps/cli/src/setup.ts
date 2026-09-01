import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { InstallationManifest, InstallationPaths } from "./config";
import {
  ensureAuthenticationSecret,
  installationExists,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "./config";
import { PROJECT_NAME } from "./constants";
import { requireComposeProject } from "./docker";
import { portAvailable, printDoctor, runDoctor } from "./doctor";
import { CliError } from "./errors";
import { checkHealth, waitForHealth } from "./health";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";
import { createSetupPresentation, type SetupPresentation, type SetupStage } from "./ui";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACCESS_MODES = ["https", "proxy", "http", "private", "local"] as const;
const SETUP_STAGES: readonly SetupStage[] = [
  { label: "Access", description: "Choose how desktop and mobile apps reach this server." },
  { label: "Owner", description: "Create the single username and password for this OpenBot." },
  { label: "Runtime", description: "Review model settings and connect OpenAI Codex." },
  { label: "Launch", description: "Apply the configuration and start Docker Compose." },
  { label: "Verify", description: "Check the deployment, credentials, and public endpoint." },
] as const;
const SETUP_KEYS = [
  "OPENBOT_TIME_ZONE",
  "OPENBOT_PI_MODEL",
  "OPENBOT_PI_THINKING",
  "OPENBOT_WORKER_CONCURRENCY",
  "OPENBOT_API_PORT",
  "OPENBOT_ACCESS_MODE",
  "OPENBOT_BIND_HOST",
  "OPENBOT_VIEWER_BIND_HOST",
  "OPENBOT_PUBLIC_HOST",
  "OPENBOT_PUBLIC_URL",
  "OPENBOT_AUTH_URL",
  "COMPOSE_PROFILES",
] as const;

export interface SetupPrompter {
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  select?<Value extends string>(
    prompt: string,
    options: readonly { label: string; value: Value; shortcut?: string }[],
    current: Value
  ): Promise<Value>;
  close(): void;
}

export interface SetupConfiguration {
  accessMode: (typeof ACCESS_MODES)[number];
  timeZone: string;
  model: string;
  thinking: (typeof THINKING_LEVELS)[number];
  workerConcurrency: string;
  apiPort: string;
  bindHost: "127.0.0.1" | "0.0.0.0";
  viewerBindHost: "127.0.0.1" | "0.0.0.0";
  publicHost: string;
  publicUrl: string;
  composeProfiles: "https" | "direct";
  ownerUsername: string;
  ownerPassword?: string;
  authenticate: boolean;
}

export interface SetupCommandOptions {
  advanced?: boolean;
  fresh?: boolean;
  presentation?: SetupPresentation;
  ownerConfigured?: boolean;
}

const requireInstallation = (paths: InstallationPaths): InstallationManifest => {
  if (!installationExists(paths)) {
    throw new CliError(
      `OpenBot is not installed at ${paths.directory}. Run openbot install first.`
    );
  }
  const manifest = readManifest(paths);
  if (!manifest)
    throw new CliError(`OpenBot installation manifest is missing at ${paths.manifest}`);
  return manifest;
};

export const createTerminalPrompter = (): SetupPrompter => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("This OpenBot command is interactive and requires a terminal.");
  }
  const question = async (message: string, secret = false): Promise<string> => {
    const output = secret
      ? new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        })
      : process.stdout;
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      if (secret) process.stdout.write(message);
      return await prompt.question(secret ? "" : message);
    } finally {
      prompt.close();
      if (secret) process.stdout.write("\n");
    }
  };
  return {
    question: (message) => question(message),
    secret: (message) => question(message, true),
    select: <Value extends string>(
      message: string,
      options: readonly { label: string; value: Value; shortcut?: string }[],
      current: Value
    ) => terminalSelect(message, options, current),
    close: () => undefined,
  };
};

type SelectionAction = "previous" | "next" | "confirm" | "cancel" | number | null;

export const selectionActionForKey = (
  character: string,
  key: { name?: string; ctrl?: boolean },
  options: readonly { shortcut?: string }[]
): SelectionAction => {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "up" || key.name === "left") return "previous";
  if (key.name === "down" || key.name === "right") return "next";
  if (key.name === "return" || key.name === "enter") return "confirm";
  if (/^[1-9]$/.test(character)) {
    const index = Number(character) - 1;
    if (index < options.length) return index;
  }
  const shortcut = character.toLowerCase();
  const shortcutIndex = options.findIndex((option) => option.shortcut?.toLowerCase() === shortcut);
  return shortcutIndex >= 0 ? shortcutIndex : null;
};

const terminalSelect = <Value extends string>(
  message: string,
  options: readonly { label: string; value: Value; shortcut?: string }[],
  current: Value
): Promise<Value> =>
  new Promise((resolve, reject) => {
    if (!options.length) {
      reject(new CliError(`${message} has no choices.`));
      return;
    }
    const input = process.stdin;
    const initialIndex = options.findIndex((option) => option.value === current);
    let selectedIndex = initialIndex >= 0 ? initialIndex : 0;
    const wasRaw = input.isRaw;
    const columns = Math.max(24, process.stdout.columns || 80);

    const render = () => {
      const selected = options[selectedIndex];
      const line = `› ${selectedIndex + 1}/${options.length}  ${selected?.label ?? ""}`;
      const visible = line.length <= columns ? line : `${line.slice(0, columns - 1)}…`;
      process.stdout.write(`\r\u001b[2K${visible}`);
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
      // readline will resume stdin for the next text/secret prompt. Pausing here
      // prevents a completed standalone selection from keeping Node or Bun alive.
      input.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (character = "", key: { name?: string; ctrl?: boolean } = {}) => {
      const action = selectionActionForKey(character, key, options);
      if (action === "cancel") {
        cleanup();
        reject(new CliError("Setup cancelled."));
        return;
      }
      if (action === "confirm") {
        const selected = options[selectedIndex];
        cleanup();
        if (selected) resolve(selected.value);
        else reject(new CliError(`${message} has no selected choice.`));
        return;
      }
      if (action === "previous") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }
      if (action === "next") {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }
      if (typeof action === "number") {
        selectedIndex = action;
        render();
      }
    };

    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    process.stdout.write(
      columns >= 64
        ? `${message}  Use ↑/↓/←/→; Enter to confirm.\n`
        : `${message}\nUse arrows; Enter to confirm.\n`
    );
    render();
  });

export const validateOwnerUsername = (value: string): string => {
  const username = value.trim().toLowerCase();
  if (username.length < 3 || username.length > 30 || !/^[a-z0-9_.]+$/.test(username)) {
    throw new Error(
      "Username must be 3-30 characters and use only letters, numbers, underscores, or dots."
    );
  }
  return username;
};

export const collectOwnerUsername = (prompter: SetupPrompter, current: string): Promise<string> =>
  ask(prompter, "OpenBot username", current, validateOwnerUsername);

export const collectConfirmedPassword = async (prompter: SetupPrompter): Promise<string> => {
  while (true) {
    const password = await prompter.secret("OpenBot password: ");
    if (password.length < 8 || password.length > 128) {
      console.log("  Password must be between 8 and 128 characters.");
      continue;
    }
    const confirmation = await prompter.secret("Confirm OpenBot password: ");
    if (password === confirmation) return password;
    console.log("  Passwords do not match. Try again.");
  }
};

const ask = async <Value extends string>(
  prompter: SetupPrompter,
  label: string,
  current: string,
  validate: (value: string) => Value
): Promise<Value> => {
  while (true) {
    const answer = (await prompter.question(`${label} [${current}]: `)).trim() || current;
    try {
      return validate(answer);
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const askRequired = async <Value extends string>(
  prompter: SetupPrompter,
  label: string,
  current: string | null,
  validate: (value: string) => Value
): Promise<Value> => {
  while (true) {
    const suffix = current ? ` [${current}]` : "";
    const answer = (await prompter.question(`${label}${suffix}: `)).trim() || current || "";
    try {
      return validate(answer);
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const confirm = async (
  prompter: SetupPrompter,
  label: string,
  defaultValue: boolean
): Promise<boolean> => {
  if (prompter.select) {
    const selected = await prompter.select(
      label,
      [
        { label: "Yes", value: "yes", shortcut: "y" },
        { label: "No", value: "no", shortcut: "n" },
      ] as const,
      defaultValue ? "yes" : "no"
    );
    return selected === "yes";
  }
  const hint = defaultValue ? "Y/n" : "y/N";
  while (true) {
    const answer = (await prompter.question(`${label} [${hint}] `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("  Enter yes or no.");
  }
};

const singleLine = (label: string, value: string): string => {
  if (!value || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line value.`);
  }
  return value;
};

const timeZone = (value: string): string => {
  const normalized = singleLine("Time zone", value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
    return normalized;
  } catch {
    throw new Error("Enter a valid IANA time zone, such as America/New_York.");
  }
};

const model = (value: string): string => {
  const normalized = singleLine("Model", value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error("Model names may contain letters, numbers, dots, colons, slashes, or hyphens.");
  }
  return normalized;
};

const thinking = (value: string): SetupConfiguration["thinking"] => {
  if (!THINKING_LEVELS.includes(value as SetupConfiguration["thinking"])) {
    throw new Error(`Choose one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return value as SetupConfiguration["thinking"];
};

const integerInRange = (label: string, minimum: number, maximum: number) => (value: string) => {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return String(parsed);
};

const accessMode = (value: string): SetupConfiguration["accessMode"] => {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, SetupConfiguration["accessMode"]> = {
    "1": "https",
    https: "https",
    public: "https",
    "public-https": "https",
    "2": "proxy",
    http: "http",
    "public-http": "http",
    proxy: "proxy",
    "external-proxy": "proxy",
    "3": "http",
    "4": "private",
    private: "private",
    vpn: "private",
    tailnet: "private",
    "5": "local",
    local: "local",
    loopback: "local",
  };
  const selected = aliases[normalized];
  if (selected) return selected;
  throw new Error("Choose 1, 2, 3, 4, or 5.");
};

const accessLabel = (value: SetupConfiguration["accessMode"]): string =>
  ({
    https: "Public HTTPS",
    proxy: "Existing HTTPS proxy",
    http: "Public HTTP",
    private: "Private network",
    local: "This machine only",
  })[value];

const privateAddressRank = (address: string): number | null => {
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 0;
  if (/^192\.168\./.test(address)) return 1;
  if (/^10\./.test(address)) return 2;
  const match = address.match(/^172\.(\d+)\./);
  if (match?.[1] && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 3;
  return null;
};

export const detectPrivateNetworkHost = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string | null => {
  const candidates: Array<{ address: string; rank: number }> = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(?:docker|br-|veth|virbr|podman|cni|flannel)/i.test(name)) continue;
    for (const address of addresses || []) {
      if (address.internal || address.family !== "IPv4") continue;
      const rank = privateAddressRank(address.address);
      if (rank !== null) candidates.push({ address: address.address, rank });
    }
  }
  candidates.sort((left, right) => left.rank - right.rank);
  return candidates[0]?.address || null;
};

const publicHost = (value: string): string => {
  const normalized = singleLine("Hostname or IPv4 address", value).toLowerCase();
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) return normalized;
    throw new Error("Enter a valid IPv4 address.");
  }
  if (
    normalized.length > 253 ||
    !normalized
      .split(".")
      .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
    throw new Error("Enter a hostname or IPv4 address clients can reach.");
  }
  return normalized;
};

const publicDomain = (value: string): string => {
  const normalized = publicHost(value);
  if (
    isIP(normalized) !== 0 ||
    !normalized.includes(".") ||
    /\.(?:local|internal|localhost|home\.arpa)$/i.test(normalized)
  ) {
    throw new Error("Enter a public domain name, such as bot.example.com.");
  }
  return normalized;
};

const configuredAccessMode = (
  current: ReadonlyMap<string, string>,
  fresh: boolean
): SetupConfiguration["accessMode"] => {
  const stored = current.get("OPENBOT_ACCESS_MODE");
  if (stored && ACCESS_MODES.includes(stored as SetupConfiguration["accessMode"])) {
    if (!fresh) return stored as SetupConfiguration["accessMode"];
  }
  if (fresh) return "https";
  const publicUrl = current.get("OPENBOT_PUBLIC_URL") || "";
  if (publicUrl.startsWith("https://")) return "https";
  if (current.get("OPENBOT_BIND_HOST") === "127.0.0.1") return "local";
  return "private";
};

const hostFromPublicUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
};

const publicUrlFor = (
  mode: SetupConfiguration["accessMode"],
  host: string,
  apiPort: string
): string => {
  if (mode === "https" || mode === "proxy") return `https://${host}`;
  const port = apiPort === "80" ? "" : `:${apiPort}`;
  return `http://${host}${port}`;
};

export const collectSetupConfiguration = async (
  current: ReadonlyMap<string, string>,
  authenticated: boolean,
  prompter: SetupPrompter,
  options: SetupCommandOptions = {},
  currentOwnerUsername = "openbot"
): Promise<SetupConfiguration> => {
  const presentation = options.presentation;
  presentation?.stage(0);
  const choices = [
    {
      title: "Public HTTPS",
      description: "A domain plus automatic TLS from the bundled Caddy proxy.",
      recommended: true,
      value: "https",
    },
    {
      title: "Existing HTTPS proxy",
      description: "Use nginx, Caddy, Traefik, or a cloud load balancer you already manage.",
      value: "proxy",
    },
    {
      title: "Public HTTP",
      description: "An IP or hostname without encryption; desktop/testing only, not iOS.",
      value: "http",
    },
    {
      title: "Private network",
      description: "A LAN, Tailscale, WireGuard, or another trusted private network.",
      value: "private",
    },
    {
      title: "This machine only",
      description: "Loopback access for development or an SSH tunnel.",
      value: "local",
    },
  ] as const;
  const currentAccess = configuredAccessMode(current, options.fresh ?? false);
  let selectedAccess: SetupConfiguration["accessMode"];
  while (true) {
    presentation?.choices(choices);
    selectedAccess = prompter.select
      ? await prompter.select(
          "Access mode",
          choices.map((choice) => ({ label: choice.title, value: choice.value })),
          currentAccess
        )
      : await ask(
          prompter,
          "Access mode",
          String(ACCESS_MODES.indexOf(currentAccess) + 1),
          accessMode
        );
    if (selectedAccess !== "http") break;
    presentation?.message(
      "Public HTTP exposes the owner password and every session token to network observers.",
      "warning"
    );
    presentation?.message(
      "The iOS app rejects public cleartext connections. Use this only for temporary desktop testing.",
      "warning"
    );
    if (await confirm(prompter, "Continue with insecure public HTTP?", false)) break;
    presentation?.message("Choose a different access mode.", "muted");
  }

  const existingPublicHost = current.get("OPENBOT_PUBLIC_HOST");
  const existingUrlHost = hostFromPublicUrl(current.get("OPENBOT_PUBLIC_URL"));
  const detectedPublicHost = detectPrivateNetworkHost();
  const existingReachableHost =
    existingUrlHost && existingUrlHost !== "127.0.0.1"
      ? existingUrlHost
      : existingPublicHost && existingPublicHost !== "127.0.0.1"
        ? existingPublicHost
        : null;
  let reachableHost = "127.0.0.1";
  if (selectedAccess === "https" || selectedAccess === "proxy") {
    reachableHost = await askRequired(
      prompter,
      "Public domain (A/AAAA record points to this server)",
      existingReachableHost,
      publicDomain
    );
    if (selectedAccess === "https") {
      presentation?.message(
        "OpenBot will publish ports 80/443; Caddy will obtain and renew the certificate.",
        "info"
      );
    } else {
      presentation?.message(
        "OpenBot will listen on loopback only. Point your HTTPS proxy at the local API port shown in the summary.",
        "info"
      );
    }
  } else if (selectedAccess === "http") {
    reachableHost = await askRequired(
      prompter,
      "Public hostname or IPv4 address",
      existingReachableHost,
      publicHost
    );
  } else if (selectedAccess === "private") {
    const defaultPrivateHost = existingReachableHost || detectedPublicHost;
    reachableHost =
      options.advanced || !defaultPrivateHost
        ? await askRequired(
            prompter,
            "Private hostname or IPv4 address",
            defaultPrivateHost,
            publicHost
          )
        : defaultPrivateHost;
    presentation?.message(
      "Private mode has no TLS. Keep it behind a trusted LAN or VPN.",
      "warning"
    );
  }

  const bindHost: SetupConfiguration["bindHost"] =
    selectedAccess === "http" || selectedAccess === "private" ? "0.0.0.0" : "127.0.0.1";
  const viewerBindHost: SetupConfiguration["viewerBindHost"] =
    selectedAccess === "private" ? "0.0.0.0" : "127.0.0.1";
  const screenViewerHost = selectedAccess === "private" ? reachableHost : "127.0.0.1";
  if (selectedAccess === "https" || selectedAccess === "proxy" || selectedAccess === "http") {
    presentation?.message(
      "Raw screen-viewer ports will remain loopback-only in this Internet-facing mode.",
      "success"
    );
  }

  presentation?.stage(1);
  const currentThinking = current.get("OPENBOT_PI_THINKING") || "high";
  let ownerUsername = currentOwnerUsername;
  let ownerPassword: string | undefined;
  if (options.ownerConfigured) {
    presentation?.message(
      `Keeping the existing owner account (${currentOwnerUsername}) and active sessions.`,
      "success"
    );
    presentation?.message(
      "Use openbot account update when you intentionally want to change credentials.",
      "muted"
    );
  } else {
    ownerUsername = await collectOwnerUsername(prompter, currentOwnerUsername);
    ownerPassword = await collectConfirmedPassword(prompter);
  }

  const configuration: SetupConfiguration = {
    accessMode: selectedAccess,
    bindHost,
    viewerBindHost,
    publicHost: screenViewerHost,
    publicUrl: "",
    composeProfiles: selectedAccess === "https" ? "https" : "direct",
    ownerUsername,
    ownerPassword,
    apiPort: current.get("OPENBOT_API_PORT") || "8787",
    timeZone: current.get("OPENBOT_TIME_ZONE") || "UTC",
    model: current.get("OPENBOT_PI_MODEL") || "gpt-5.5",
    thinking: THINKING_LEVELS.includes(currentThinking as SetupConfiguration["thinking"])
      ? (currentThinking as SetupConfiguration["thinking"])
      : "high",
    workerConcurrency: current.get("OPENBOT_WORKER_CONCURRENCY") || "8",
    authenticate: false,
  };

  presentation?.stage(2);
  if (options.advanced) {
    configuration.apiPort = await ask(
      prompter,
      "API port",
      configuration.apiPort,
      integerInRange("API port", 1, 65535)
    );
    configuration.timeZone = await ask(prompter, "Time zone", configuration.timeZone, timeZone);
    configuration.model = await ask(prompter, "OpenAI Codex model", configuration.model, model);
    configuration.thinking = prompter.select
      ? await prompter.select(
          "Reasoning effort",
          THINKING_LEVELS.map((value) => ({ label: value, value })),
          configuration.thinking
        )
      : await ask(
          prompter,
          "Reasoning effort (minimal/low/medium/high/xhigh/max)",
          configuration.thinking,
          thinking
        );
    configuration.workerConcurrency = await ask(
      prompter,
      "Concurrent bot jobs",
      configuration.workerConcurrency,
      integerInRange("Concurrent bot jobs", 1, 64)
    );
  }
  configuration.publicUrl = publicUrlFor(
    configuration.accessMode,
    reachableHost,
    configuration.apiPort
  );
  configuration.authenticate = await confirm(
    prompter,
    authenticated ? "Sign in to OpenAI Codex again?" : "Sign in to OpenAI Codex now?",
    !authenticated
  );
  return configuration;
};

const updateEnvironment = (contents: string, configuration: SetupConfiguration): string => {
  const values: Record<(typeof SETUP_KEYS)[number], string> = {
    OPENBOT_TIME_ZONE: configuration.timeZone,
    OPENBOT_PI_MODEL: configuration.model,
    OPENBOT_PI_THINKING: configuration.thinking,
    OPENBOT_WORKER_CONCURRENCY: configuration.workerConcurrency,
    OPENBOT_API_PORT: configuration.apiPort,
    OPENBOT_ACCESS_MODE: configuration.accessMode,
    OPENBOT_BIND_HOST: configuration.bindHost,
    OPENBOT_VIEWER_BIND_HOST: configuration.viewerBindHost,
    OPENBOT_PUBLIC_HOST: configuration.publicHost,
    OPENBOT_PUBLIC_URL: configuration.publicUrl,
    OPENBOT_AUTH_URL: configuration.publicUrl,
    COMPOSE_PROFILES: configuration.composeProfiles,
  };
  let updated = contents;
  for (const key of SETUP_KEYS) updated = replaceEnvironmentValue(updated, key, values[key]);
  return updated;
};

const waitForAuthentication = async (
  paths: InstallationPaths,
  timeoutMs = 15_000
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(paths);
    if (health.ok && health.agent === "ready") return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
};

export const setupCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: SetupCommandOptions = {},
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  const manifest = requireInstallation(paths);
  const project = requireComposeProject(paths, runner, manifest.projectName || PROJECT_NAME);
  const previousEnvironment = readFileSync(paths.environment, "utf8");
  const current = parseEnvironment(previousEnvironment);
  const initialHealth = await checkHealth(paths);
  const prompter = suppliedPrompter || createTerminalPrompter();
  const presentation =
    options.presentation ??
    createSetupPresentation({ version: manifest.version, stages: SETUP_STAGES });

  presentation.start();
  presentation.message(`Installation: ${paths.directory}`, "muted");
  presentation.message("Press Enter to keep the value shown in brackets.", "muted");
  let configuration: SetupConfiguration | null = null;
  try {
    while (!configuration) {
      const candidate = await collectSetupConfiguration(
        current,
        initialHealth.agent === "ready",
        prompter,
        {
          ...options,
          fresh: options.fresh ?? !manifest.ownerUsername,
          ownerConfigured: Boolean(manifest.ownerUsername),
          presentation,
        },
        manifest.ownerUsername || "openbot"
      );

      if (!options.advanced) {
        presentation.message(
          `Using ${candidate.model}, ${candidate.thinking} reasoning, and local API port ${candidate.apiPort}.`,
          "info"
        );
        presentation.message("Run openbot setup --advanced to change these settings.", "muted");
      }

      presentation.stage(3);
      presentation.summary("Configuration ready", [
        { label: "Access", value: accessLabel(candidate.accessMode) },
        { label: "Address", value: candidate.publicUrl },
        { label: "Owner", value: candidate.ownerUsername },
        { label: "Model", value: `${candidate.model} · ${candidate.thinking}` },
      ]);
      if (candidate.accessMode === "proxy") {
        presentation.message(
          `Proxy target: http://127.0.0.1:${candidate.apiPort} (WebSocket upgrades must be enabled).`,
          "info"
        );
      }
      while (true) {
        const answer = prompter.select
          ? await prompter.select(
              "Apply this configuration?",
              [
                { label: "Apply and start OpenBot", value: "yes", shortcut: "y" },
                { label: "Go back", value: "back", shortcut: "b" },
                { label: "Cancel without changes", value: "no", shortcut: "n" },
              ] as const,
              "yes"
            )
          : (await prompter.question("Apply this configuration? [Y/n/back] ")).trim().toLowerCase();
        if (!answer || answer === "y" || answer === "yes") {
          configuration = candidate;
          break;
        }
        if (answer === "n" || answer === "no") {
          presentation.message("Setup cancelled; no configuration was changed.", "muted");
          return;
        }
        if (answer === "b" || answer === "back") {
          presentation.message("Returning to the access stage.", "muted");
          break;
        }
        presentation.message("Enter yes, no, or back.", "warning");
      }
    }
  } finally {
    if (!suppliedPrompter) prompter.close();
  }
  const previousAccessMode = current.get("OPENBOT_ACCESS_MODE") || "local";
  if (configuration.accessMode === "https" && previousAccessMode !== "https") {
    const occupied = (
      await Promise.all(
        [80, 443].map(async (port) => ({ port, available: await portAvailable("0.0.0.0", port) }))
      )
    ).filter(({ available }) => !available);
    if (occupied.length) {
      throw new CliError(
        `Bundled HTTPS cannot start because port${occupied.length === 1 ? "" : "s"} ${occupied.map(({ port }) => port).join(", ")} ${occupied.length === 1 ? "is" : "are"} already in use. Stop the conflicting proxy or rerun setup and choose Existing HTTPS proxy.`
      );
    }
  }
  const nextEnvironment = ensureAuthenticationSecret(
    updateEnvironment(previousEnvironment, configuration)
  );
  const changed = nextEnvironment !== previousEnvironment;
  if (changed) {
    writeFileAtomic(paths.environment, nextEnvironment, 0o600);
    const validation = project.run(["config", "--quiet"]);
    if (validation.status !== 0) {
      writeFileAtomic(paths.environment, previousEnvironment, 0o600);
      throw new CliError(
        `The new configuration is invalid: ${validation.stderr.trim() || validation.stdout.trim() || "Docker Compose rejected it"}`
      );
    }
  }

  if (changed || !initialHealth.ok || manifest.uninstalledAt) {
    presentation.message(changed ? "Applying configuration…" : "Starting OpenBot…", "info");
    try {
      if (configuration.accessMode !== "https") {
        // A profile-disabled service is not guaranteed to be removed by `up --remove-orphans`.
        // Stop a previously enabled proxy explicitly when switching away from HTTPS.
        project.run(["stop", "caddy"]);
      }
      project.runOrThrow(["up", "--detach", "--remove-orphans"], { inherit: true });
      process.stdout.write("Waiting for OpenBot");
      const health = await waitForHealth(paths);
      if (!health.ok) throw new CliError(`OpenBot did not become healthy: ${health.detail}`);
      presentation.message(
        `Core services are ready at ${health.url.replace(/\/api\/v0\/health$/, "")}`,
        "success"
      );
      if (manifest.uninstalledAt) {
        writeManifest(paths, { ...manifest, uninstalledAt: undefined });
      }
    } catch (error) {
      if (changed) {
        writeFileAtomic(paths.environment, previousEnvironment, 0o600);
        const recovery = project.run(["up", "--detach", "--remove-orphans"], { inherit: true });
        throw new CliError(
          `Setup failed and the previous configuration was restored${
            recovery.status === 0 ? " and restarted" : ", but it could not be restarted"
          }: ${error instanceof Error ? error.message : error}`
        );
      }
      throw error;
    }
  } else {
    presentation.message(
      changed ? "Configuration applied." : "Configuration is unchanged.",
      "success"
    );
  }

  if (configuration.ownerPassword) {
    presentation.message("Setting the OpenBot owner credentials…", "info");
    project.runOrThrow(["exec", "--no-TTY", "server", "bun", "main.js", "owner-credentials"], {
      input: JSON.stringify({
        operation: "setup",
        username: configuration.ownerUsername,
        password: configuration.ownerPassword,
      }),
    });
    writeManifest(paths, {
      ...manifest,
      ownerUsername: configuration.ownerUsername,
      uninstalledAt: undefined,
    });
    presentation.message(`OpenBot sign-in is ready for ${configuration.ownerUsername}.`, "success");
  }

  if (configuration.authenticate) {
    presentation.message("Starting OpenAI Codex sign-in…", "info");
    presentation.message(
      "Provider credentials are handled by Codex and are not written to .env.",
      "muted"
    );
    project.runOrThrow(["exec", "computer", "openbot-pi-login"], { inherit: true });
    if (!(await waitForAuthentication(paths))) {
      throw new CliError(
        "OpenAI Codex sign-in completed, but OpenBot still reports authentication as missing. Run openbot provider login to retry only this step."
      );
    }
    presentation.message("OpenAI Codex authentication is ready.", "success");
  }

  presentation.stage(4);
  presentation.message("Running OpenBot doctor…", "info");
  const diagnosis = await runDoctor(paths, runner, manifest.projectName || PROJECT_NAME);
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Setup completed with blocking doctor failures.", 2);
  if (["https", "proxy", "http"].includes(configuration.accessMode)) {
    const readiness = await inspectPublicReadiness(configuration.publicUrl);
    const publicFailure = [
      readiness.dns.ok ? null : `DNS: ${readiness.dns.detail}`,
      readiness.endpoint.ok ? null : `endpoint: ${readiness.endpoint.detail}`,
      readiness.tls && !readiness.tls.ok ? `TLS: ${readiness.tls.detail}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    if (publicFailure) {
      throw new CliError(
        `The local stack is healthy, but the configured public endpoint ${configuration.publicUrl} could not be verified: ${publicFailure}. ${
          configuration.accessMode === "https"
            ? "Confirm DNS points here and inbound TCP ports 80 and 443 are open, then run openbot doctor."
            : configuration.accessMode === "proxy"
              ? `Confirm your proxy forwards HTTPS and WebSockets to http://127.0.0.1:${configuration.apiPort}, then run openbot doctor.`
              : "Confirm the host, port, and cloud firewall rules, then run openbot doctor."
        }`,
        2
      );
    } else {
      presentation.message(`Public endpoint verified at ${configuration.publicUrl}.`, "success");
    }
  }
  presentation.summary("OpenBot is ready", [
    { label: "Server", value: configuration.publicUrl },
    { label: "Username", value: configuration.ownerUsername },
    { label: "Security", value: accessLabel(configuration.accessMode) },
    { label: "Manage", value: "openbot status · openbot doctor · openbot update" },
  ]);
};
