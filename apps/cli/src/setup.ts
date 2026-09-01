import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { InstallationManifest, InstallationPaths } from "./config";
import {
  installationExists,
  ensureAuthenticationSecret,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "./config";
import { PROJECT_NAME } from "./constants";
import { requireComposeProject } from "./docker";
import { printDoctor, runDoctor } from "./doctor";
import { CliError } from "./errors";
import { checkHealth, waitForHealth } from "./health";
import type { CommandRunner } from "./process";
import { createSetupPresentation, type SetupPresentation, type SetupStage } from "./ui";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACCESS_MODES = ["https", "http", "private", "local"] as const;
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
  ownerPassword: string;
  authenticate: boolean;
}

export interface SetupCommandOptions {
  advanced?: boolean;
  fresh?: boolean;
  presentation?: SetupPresentation;
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
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  return {
    question: (message) => prompt.question(message),
    secret: async (message) => {
      process.stdout.write(message);
      muted = true;
      try {
        return await prompt.question("");
      } finally {
        muted = false;
        process.stdout.write("\n");
      }
    },
    close: () => prompt.close(),
  };
};

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
    "2": "http",
    http: "http",
    "public-http": "http",
    "3": "private",
    private: "private",
    vpn: "private",
    tailnet: "private",
    "4": "local",
    local: "local",
    loopback: "local",
  };
  const selected = aliases[normalized];
  if (selected) return selected;
  throw new Error("Choose 1, 2, 3, or 4.");
};

const accessLabel = (value: SetupConfiguration["accessMode"]): string =>
  ({
    https: "Public HTTPS",
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
  if (mode === "https") return `https://${host}`;
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
    },
    {
      title: "Public HTTP",
      description: "An IP or hostname without encryption; desktop/testing only, not iOS.",
    },
    {
      title: "Private network",
      description: "A LAN, Tailscale, WireGuard, or another trusted private network.",
    },
    {
      title: "This machine only",
      description: "Loopback access for development or an SSH tunnel.",
    },
  ] as const;
  const currentAccess = configuredAccessMode(current, options.fresh ?? false);
  let selectedAccess: SetupConfiguration["accessMode"];
  while (true) {
    presentation?.choices(choices);
    selectedAccess = await ask(
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
  if (selectedAccess === "https") {
    reachableHost = await askRequired(
      prompter,
      "Public domain (A/AAAA record points to this server)",
      existingReachableHost,
      publicDomain
    );
    presentation?.message(
      "OpenBot will publish ports 80/443; Caddy will obtain and renew the certificate.",
      "info"
    );
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
  if (selectedAccess === "https" || selectedAccess === "http") {
    presentation?.message(
      "Raw screen-viewer ports will remain loopback-only in this Internet-facing mode.",
      "success"
    );
  }

  presentation?.stage(1);
  const currentThinking = current.get("OPENBOT_PI_THINKING") || "high";
  const ownerUsername = await collectOwnerUsername(prompter, currentOwnerUsername);
  const ownerPassword = await collectConfirmedPassword(prompter);

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
    configuration.thinking = await ask(
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

const checkPublicEndpoint = async (publicUrl: string): Promise<string | null> => {
  try {
    const response = await fetch(new URL("/api/v0/health", publicUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return `HTTP ${response.status}`;
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === "ready" ? null : "the public endpoint did not report ready";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
  let configuration: SetupConfiguration;
  try {
    configuration = await collectSetupConfiguration(
      current,
      initialHealth.agent === "ready",
      prompter,
      {
        ...options,
        fresh: options.fresh ?? !manifest.ownerUsername,
        presentation,
      },
      manifest.ownerUsername || "openbot"
    );
  } finally {
    if (!suppliedPrompter) prompter.close();
  }

  if (!options.advanced) {
    presentation.message(
      `Using ${configuration.model}, ${configuration.thinking} reasoning, and local API port ${configuration.apiPort}.`,
      "info"
    );
    presentation.message("Run openbot setup --advanced to change these settings.", "muted");
  }

  presentation.stage(3);
  presentation.summary("Configuration ready", [
    { label: "Access", value: accessLabel(configuration.accessMode) },
    { label: "Address", value: configuration.publicUrl },
    { label: "Owner", value: configuration.ownerUsername },
    { label: "Model", value: `${configuration.model} · ${configuration.thinking}` },
  ]);
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

  if (configuration.authenticate) {
    presentation.message("Starting OpenAI Codex sign-in…", "info");
    presentation.message(
      "Provider credentials are handled by Codex and are not written to .env.",
      "muted"
    );
    project.runOrThrow(["exec", "computer", "openbot-pi-login"], { inherit: true });
    if (!(await waitForAuthentication(paths))) {
      throw new CliError(
        "OpenAI Codex sign-in completed, but OpenBot still reports authentication as missing."
      );
    }
    presentation.message("OpenAI Codex authentication is ready.", "success");
  }

  presentation.stage(4);
  presentation.message("Running OpenBot doctor…", "info");
  const diagnosis = await runDoctor(paths, runner, manifest.projectName || PROJECT_NAME);
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Setup completed with blocking doctor failures.", 2);
  if (configuration.accessMode === "https" || configuration.accessMode === "http") {
    const publicFailure = await checkPublicEndpoint(configuration.publicUrl);
    if (publicFailure) {
      presentation.message(
        `The local stack is healthy, but ${configuration.publicUrl} could not be verified: ${publicFailure}`,
        "warning"
      );
      if (configuration.accessMode === "https") {
        presentation.message(
          "Confirm DNS points here and inbound TCP ports 80 and 443 are open, then run openbot doctor.",
          "warning"
        );
      }
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
