import { readFileSync } from "node:fs";
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

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SETUP_KEYS = [
  "OPENBOT_TIME_ZONE",
  "OPENBOT_PI_MODEL",
  "OPENBOT_PI_THINKING",
  "OPENBOT_WORKER_CONCURRENCY",
  "OPENBOT_API_PORT",
  "OPENBOT_BIND_HOST",
  "OPENBOT_PUBLIC_HOST",
] as const;

export interface SetupPrompter {
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  close(): void;
}

export interface SetupConfiguration {
  timeZone: string;
  model: string;
  thinking: (typeof THINKING_LEVELS)[number];
  workerConcurrency: string;
  apiPort: string;
  bindHost: "127.0.0.1" | "0.0.0.0";
  publicHost: string;
  ownerUsername: string;
  ownerPassword: string;
  authenticate: boolean;
}

export interface SetupCommandOptions {
  advanced?: boolean;
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

const networkAccess = (value: string): "local" | "private" => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "private") return normalized;
  throw new Error("Choose local or private.");
};

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
  const normalized = singleLine("Public hostname", value);
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
    throw new Error("Enter a hostname or private IPv4 address clients can reach.");
  }
  return normalized;
};

export const collectSetupConfiguration = async (
  current: ReadonlyMap<string, string>,
  authenticated: boolean,
  prompter: SetupPrompter,
  options: SetupCommandOptions = {},
  currentOwnerUsername = "openbot"
): Promise<SetupConfiguration> => {
  const currentBindHost = current.get("OPENBOT_BIND_HOST") || "127.0.0.1";
  const currentNetwork = currentBindHost === "127.0.0.1" ? "local" : "private";
  const configuredNetwork = await ask(
    prompter,
    "Network access (local/private)",
    currentNetwork,
    networkAccess
  );
  const bindHost: SetupConfiguration["bindHost"] =
    configuredNetwork === "local" ? "127.0.0.1" : "0.0.0.0";
  if (bindHost === "0.0.0.0") {
    console.log(
      "  Warning: screen viewer ports have no separate login; expose them only on a trusted private network or VPN."
    );
  }
  const existingPublicHost = current.get("OPENBOT_PUBLIC_HOST");
  const detectedPublicHost = detectPrivateNetworkHost();
  const defaultPublicHost =
    existingPublicHost && existingPublicHost !== "127.0.0.1"
      ? existingPublicHost
      : detectedPublicHost;
  const configuredPublicHost =
    bindHost === "127.0.0.1"
      ? "127.0.0.1"
      : options.advanced || !defaultPublicHost
        ? await ask(
            prompter,
            "Hostname or private IP clients should use",
            defaultPublicHost || "openbot.local",
            publicHost
          )
        : defaultPublicHost;

  const currentThinking = current.get("OPENBOT_PI_THINKING") || "high";
  const ownerUsername = await collectOwnerUsername(prompter, currentOwnerUsername);
  const ownerPassword = await collectConfirmedPassword(prompter);

  const configuration: SetupConfiguration = {
    bindHost,
    publicHost: configuredPublicHost,
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
    OPENBOT_BIND_HOST: configuration.bindHost,
    OPENBOT_PUBLIC_HOST: configuration.publicHost,
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

  console.log(
    `${options.advanced ? "Advanced configuration for" : "Set up"} OpenBot ${manifest.version} at ${paths.directory}`
  );
  console.log("Press Enter to keep the value shown in brackets.\n");
  let configuration: SetupConfiguration;
  try {
    configuration = await collectSetupConfiguration(
      current,
      initialHealth.agent === "ready",
      prompter,
      options,
      manifest.ownerUsername || "openbot"
    );
  } finally {
    if (!suppliedPrompter) prompter.close();
  }

  if (!options.advanced) {
    console.log(
      `\nUsing ${configuration.model}, ${configuration.thinking} reasoning, and port ${configuration.apiPort}.`
    );
    console.log("Run openbot setup --advanced to change these settings.");
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
    console.log(changed ? "Applying configuration…" : "Starting OpenBot…");
    try {
      project.runOrThrow(["up", "--detach", "--remove-orphans"], { inherit: true });
      process.stdout.write("Waiting for OpenBot");
      const health = await waitForHealth(paths);
      if (!health.ok) throw new CliError(`OpenBot did not become healthy: ${health.detail}`);
      console.log(`OpenBot is ready at ${health.url.replace(/\/api\/v0\/health$/, "")}`);
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
    console.log(changed ? "Configuration applied." : "Configuration is unchanged.");
  }

  console.log("\nSetting the OpenBot owner credentials…");
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
  console.log(`OpenBot sign-in is ready for ${configuration.ownerUsername}.`);

  if (configuration.authenticate) {
    console.log("\nStarting OpenAI Codex sign-in…");
    console.log("Credentials are handled by the provider login and are not written to .env.\n");
    project.runOrThrow(["exec", "computer", "openbot-pi-login"], { inherit: true });
    if (!(await waitForAuthentication(paths))) {
      throw new CliError(
        "OpenAI Codex sign-in completed, but OpenBot still reports authentication as missing."
      );
    }
    console.log("OpenAI Codex authentication is ready.");
  }

  console.log("\nChecking the completed setup…");
  const diagnosis = await runDoctor(paths, runner, manifest.projectName || PROJECT_NAME);
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Setup completed with blocking doctor failures.", 2);
  console.log(
    `OpenBot server address: http://${configuration.publicHost}:${configuration.apiPort}`
  );
};
