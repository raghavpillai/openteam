import { readFileSync } from "node:fs";
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
import { API_PORT, PROJECT_NAME } from "./constants";
import {
  type DetectedLogin,
  detectReusableLogins,
  type LoginDetectionOptions,
  readReusableCredential,
} from "./detected-logins";
import { type ComposeProject, requireComposeProject } from "./docker";
import { printDoctor, runDoctor, suggestApiPort } from "./doctor";
import { CliError } from "./errors";
import { checkHealth, waitForHealth } from "./health";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";
import {
  readRuntimeInferenceSettings,
  type RuntimeInferenceSettings,
  writeRuntimeInferenceSettings,
} from "./runtime-settings";
import { runSetupSession, type SetupSessionInput } from "./setup-session";
import {
  assertOwnServer,
  assertPortsAvailable,
  portRequirementsFromConfiguration,
  runningServices,
} from "./stack";
import {
  ACCESS_CHOICES,
  ACCESS_MODES,
  accessLabel,
  accessModeNotes,
  BUILTIN_PROVIDER_CHOICES,
  bindHostsFor,
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_CHOICE,
  configuredAccessMode,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_RUNTIME_INFERENCE,
  defaultProviderAuthType,
  detectPrivateNetworkHost,
  existingReachableHost,
  HTTP_WARNINGS,
  publicUrlFor,
  recommendedAccessMode,
  SETUP_STAGES,
  type SetupConfiguration,
  type SetupCustomProvider,
  THINKING_LEVELS,
  validateAccessMode,
  validateCustomProviderApi,
  validateIntegerInRange,
  validateModel,
  validateOwnerPassword,
  validateOwnerUsername,
  validateProviderBaseUrl,
  validateProviderId,
  validateProviderName,
  validateProviderSelection,
  validatePublicDomain,
  validatePublicHost,
  validateThinking,
  validateTimeZone,
} from "./setup-values";
import {
  createSetupPresentation,
  type MessageTone,
  renderSelectionPrompt,
  renderSelectionResult,
  type SetupPresentation,
} from "./ui";

export {
  detectPrivateNetworkHost,
  type SetupConfiguration,
  type SetupCustomProvider,
  validateOwnerUsername,
} from "./setup-values";

const SETUP_KEYS = [
  "OPENTEAM_TIME_ZONE",
  "OPENTEAM_WORKER_CONCURRENCY",
  "OPENTEAM_API_PORT",
  "OPENTEAM_ACCESS_MODE",
  "OPENTEAM_BIND_HOST",
  "OPENTEAM_VIEWER_BIND_HOST",
  "OPENTEAM_PUBLIC_HOST",
  "OPENTEAM_PUBLIC_URL",
  "OPENTEAM_AUTH_URL",
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
  /**
   * Run the whole guided setup as one keyboard-driven session. Resolves with the
   * configuration to apply, or `null` when the user cancels without changes.
   */
  session?(input: SetupSessionInput): Promise<SetupConfiguration | null>;
  close(): void;
}

export interface SetupCommandOptions {
  advanced?: boolean;
  fresh?: boolean;
  presentation?: SetupPresentation;
  ownerConfigured?: boolean;
  /** Detected tailnet or LAN address; `undefined` detects it, `null` means none. */
  detectedPrivateHost?: string | null;
  /** Vendor CLI sign-ins to offer for reuse; `undefined` detects them. */
  detectedLogins?: readonly DetectedLogin[];
  /** Where to look for those sign-ins; defaults to this machine. */
  loginDetection?: LoginDetectionOptions;
}

export const supportsInteractiveSelection = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => environment.TERM?.toLowerCase() !== "dumb";

const requireInstallation = (paths: InstallationPaths): InstallationManifest => {
  if (!installationExists(paths)) {
    throw new CliError(
      `OpenTeam is not installed at ${paths.directory}. Run openteam install first.`
    );
  }
  const manifest = readManifest(paths);
  if (!manifest)
    throw new CliError(`OpenTeam installation manifest is missing at ${paths.manifest}`);
  return manifest;
};

export const createTerminalPrompter = (): SetupPrompter => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("This OpenTeam command is interactive and requires a terminal.");
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
  const prompter: SetupPrompter = {
    question: (message) => question(message),
    secret: (message) => question(message, true),
    close: () => undefined,
  };
  if (supportsInteractiveSelection()) {
    prompter.select = <Value extends string>(
      message: string,
      options: readonly { label: string; value: Value; shortcut?: string }[],
      current: Value
    ) => terminalSelect(message, options, current);
    prompter.session = (input) => runSetupSession(input);
  }
  return prompter;
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
    let renderedLineCount = 0;

    const render = () => {
      const lines = renderSelectionPrompt({
        message,
        options,
        index: selectedIndex,
        width: process.stdout.columns,
      });
      if (renderedLineCount > 0) {
        process.stdout.write(
          `\r${renderedLineCount > 1 ? `\u001b[${renderedLineCount - 1}A` : ""}`
        );
      }
      for (const [index, line] of lines.entries()) {
        process.stdout.write(`\u001b[2K${line}${index < lines.length - 1 ? "\n" : ""}`);
      }
      renderedLineCount = lines.length;
    };
    const clear = () => {
      if (!renderedLineCount) return;
      process.stdout.write(`\r${renderedLineCount > 1 ? `\u001b[${renderedLineCount - 1}A` : ""}`);
      for (let index = 0; index < renderedLineCount; index += 1) {
        process.stdout.write(`\u001b[2K${index < renderedLineCount - 1 ? "\n" : ""}`);
      }
      if (renderedLineCount > 1) process.stdout.write(`\r\u001b[${renderedLineCount - 1}A`);
      renderedLineCount = 0;
    };
    const cleanup = (selectedLabel?: string) => {
      input.off("keypress", onKeypress);
      process.stdout.off("resize", render);
      if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
      // readline will resume stdin for the next text/secret prompt. Pausing here
      // prevents a completed standalone selection from keeping Node or Bun alive.
      input.pause();
      clear();
      if (selectedLabel !== undefined) {
        process.stdout.write(
          `${renderSelectionResult(message, selectedLabel, undefined, process.stdout.columns)}\n`
        );
      }
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
        cleanup(selected?.label);
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
    process.stdout.on("resize", render);
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    render();
  });

export const collectOwnerUsername = (prompter: SetupPrompter, current: string): Promise<string> =>
  ask(prompter, "OpenTeam username", current, validateOwnerUsername);

export const collectConfirmedPassword = async (prompter: SetupPrompter): Promise<string> => {
  while (true) {
    const password = await prompter.secret("OpenTeam password: ");
    try {
      validateOwnerPassword(password);
    } catch (error) {
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const confirmation = await prompter.secret("Confirm OpenTeam password: ");
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

const collectProviderSecret = async (
  prompter: SetupPrompter,
  providerId: string
): Promise<string> => {
  while (true) {
    const secret = (await prompter.secret(`${providerId} API key or password: `)).trim();
    if (secret) return secret;
    console.log("  Provider API key or password cannot be empty.");
  }
};

const collectRuntimeConfiguration = async (
  configuration: SetupConfiguration,
  currentProvider: string,
  prompter: SetupPrompter,
  presentation?: SetupPresentation
): Promise<void> => {
  const providerChoices: Array<{ label: string; value: string }> = [...BUILTIN_PROVIDER_CHOICES];
  const currentIsBuiltin = BUILTIN_PROVIDER_CHOICES.some(
    (choice) => choice.value === currentProvider
  );
  if (!currentIsBuiltin) {
    providerChoices.push({
      label: `Keep existing provider (${currentProvider})`,
      value: currentProvider,
    });
  }
  providerChoices.push(CUSTOM_PROVIDER_CHOICE);
  presentation?.choices([
    ...BUILTIN_PROVIDER_CHOICES.map((choice) => ({
      title: choice.label,
      description: choice.description,
      recommended: currentProvider === choice.value,
    })),
    {
      title: CUSTOM_PROVIDER_CHOICE.label,
      description: CUSTOM_PROVIDER_CHOICE.description,
      recommended: !currentIsBuiltin,
    },
  ]);
  const selectedProvider = prompter.select
    ? await prompter.select("Inference provider", providerChoices, currentProvider)
    : await ask(
        prompter,
        "Inference provider (openai-codex/anthropic/openai/custom)",
        currentProvider,
        (value) => validateProviderSelection(value, currentProvider)
      );

  if (selectedProvider === "custom") {
    const id = await ask(prompter, "Custom provider id", "my-provider", validateProviderId);
    const name = await ask(prompter, "Custom provider name", id, validateProviderName);
    const baseUrl = await askRequired(
      prompter,
      "Custom provider base URL",
      null,
      validateProviderBaseUrl
    );
    const api = prompter.select
      ? await prompter.select(
          "Compatible API",
          CUSTOM_PROVIDER_APIS.map((value) => ({ label: value, value })),
          "openai-responses"
        )
      : await ask(
          prompter,
          "Compatible API (openai-responses/openai-completions/anthropic-messages/google-generative-ai)",
          "openai-responses",
          validateCustomProviderApi
        );
    const selectedModel = await ask(prompter, "Inference model", "model", validateModel);
    const reasoning = await confirm(prompter, "Does this model support reasoning?", true);
    configuration.provider = id;
    configuration.model = selectedModel;
    configuration.customProvider = {
      id,
      name,
      baseUrl,
      api,
      model: selectedModel,
      reasoning,
    };
    return;
  }

  configuration.provider = selectedProvider;
  configuration.customProvider = undefined;
  const selectedDefault =
    selectedProvider === currentProvider
      ? configuration.model
      : (DEFAULT_PROVIDER_MODELS[selectedProvider] ?? configuration.model);
  configuration.model = await ask(prompter, "Inference model", selectedDefault, validateModel);
};

/**
 * Sequential prompt flow used by terminals without cursor control and by tests.
 * Interactive terminals run the same questions as a single session instead.
 */
export const collectSetupConfiguration = async (
  current: ReadonlyMap<string, string>,
  authenticated: boolean,
  prompter: SetupPrompter,
  options: SetupCommandOptions = {},
  currentOwnerUsername = "openteam",
  currentInference: RuntimeInferenceSettings = DEFAULT_RUNTIME_INFERENCE
): Promise<SetupConfiguration> => {
  const presentation = options.presentation;
  presentation?.stage(0);
  const detectedPublicHost =
    options.detectedPrivateHost === undefined
      ? detectPrivateNetworkHost()
      : options.detectedPrivateHost;
  const recommendedAccess = recommendedAccessMode(detectedPublicHost);
  const currentAccess = configuredAccessMode(current, options.fresh ?? false, detectedPublicHost);
  let selectedAccess: SetupConfiguration["accessMode"];
  while (true) {
    presentation?.choices(
      ACCESS_CHOICES.map((choice) => ({
        ...choice,
        recommended: choice.value === recommendedAccess,
      }))
    );
    selectedAccess = prompter.select
      ? await prompter.select(
          "Access mode",
          ACCESS_CHOICES.map((choice) => ({ label: choice.title, value: choice.value })),
          currentAccess
        )
      : await ask(
          prompter,
          "Access mode",
          String(ACCESS_MODES.indexOf(currentAccess) + 1),
          validateAccessMode
        );
    if (selectedAccess !== "http") break;
    for (const warning of HTTP_WARNINGS) presentation?.message(warning, "warning");
    if (await confirm(prompter, "Continue with insecure public HTTP?", false)) break;
    presentation?.message("Choose a different access mode.", "muted");
  }

  const existingHost = existingReachableHost(current);
  let reachableHost = "127.0.0.1";
  if (selectedAccess === "https" || selectedAccess === "proxy") {
    reachableHost = await askRequired(
      prompter,
      "Public domain (A/AAAA record points to this server)",
      existingHost,
      validatePublicDomain
    );
  } else if (selectedAccess === "http") {
    reachableHost = await askRequired(
      prompter,
      "Public hostname or IPv4 address",
      existingHost,
      validatePublicHost
    );
  } else if (selectedAccess === "private") {
    const defaultPrivateHost = existingHost || detectedPublicHost;
    reachableHost =
      options.advanced || !defaultPrivateHost
        ? await askRequired(
            prompter,
            "Private hostname or IPv4 address",
            defaultPrivateHost,
            validatePublicHost
          )
        : defaultPrivateHost;
  }
  for (const note of accessModeNotes(selectedAccess)) presentation?.message(note.text, note.tone);

  presentation?.stage(1);
  const currentThinking = currentInference.reasoning;
  let ownerUsername = currentOwnerUsername;
  let ownerPassword: string | undefined;
  if (options.ownerConfigured) {
    presentation?.message(
      `Keeping the existing owner account (${currentOwnerUsername}) and active sessions.`,
      "success"
    );
    presentation?.message(
      "Use openteam account update when you intentionally want to change credentials.",
      "muted"
    );
  } else {
    ownerUsername = await collectOwnerUsername(prompter, currentOwnerUsername);
    ownerPassword = await collectConfirmedPassword(prompter);
  }

  const configuration: SetupConfiguration = {
    accessMode: selectedAccess,
    ...bindHostsFor(selectedAccess, reachableHost),
    publicUrl: "",
    ownerUsername,
    ownerPassword,
    apiPort: current.get("OPENTEAM_API_PORT") || String(API_PORT),
    timeZone: current.get("OPENTEAM_TIME_ZONE") || "UTC",
    provider: currentInference.providerId,
    model: currentInference.modelId,
    thinking: THINKING_LEVELS.includes(currentThinking as SetupConfiguration["thinking"])
      ? (currentThinking as SetupConfiguration["thinking"])
      : "high",
    workerConcurrency: current.get("OPENTEAM_WORKER_CONCURRENCY") || "8",
    authenticate: false,
    authType: defaultProviderAuthType(currentInference.providerId),
  };

  presentation?.stage(2);
  if (options.advanced) {
    configuration.apiPort = await ask(
      prompter,
      "API port",
      configuration.apiPort,
      validateIntegerInRange("API port", 1, 65535)
    );
    configuration.timeZone = await ask(
      prompter,
      "Time zone",
      configuration.timeZone,
      validateTimeZone
    );
  }
  await collectRuntimeConfiguration(
    configuration,
    currentInference.providerId,
    prompter,
    presentation
  );
  if (options.advanced) {
    configuration.thinking = prompter.select
      ? await prompter.select(
          "Reasoning effort",
          THINKING_LEVELS.map((value) => ({ label: value, value })),
          configuration.thinking
        )
      : await ask(
          prompter,
          "Reasoning effort (off/minimal/low/medium/high/xhigh/max)",
          configuration.thinking,
          validateThinking
        );
    configuration.workerConcurrency = await ask(
      prompter,
      "Concurrent bot jobs",
      configuration.workerConcurrency,
      validateIntegerInRange("Concurrent bot jobs", 1, 64)
    );
  }
  configuration.publicUrl = publicUrlFor(
    configuration.accessMode,
    reachableHost,
    configuration.apiPort
  );
  configuration.authenticate = await confirm(
    prompter,
    authenticated && configuration.provider === currentInference.providerId
      ? `Configure ${configuration.provider} authentication again?`
      : `Configure ${configuration.provider} authentication now?`,
    !authenticated || configuration.provider !== currentInference.providerId
  );
  if (configuration.authenticate) {
    if (configuration.provider === "anthropic") {
      configuration.authType = prompter.select
        ? await prompter.select(
            "Anthropic authentication",
            [
              { label: "Claude Pro/Max", value: "oauth" },
              { label: "Anthropic API key", value: "api_key" },
            ] as const,
            "oauth"
          )
        : await ask(prompter, "Anthropic authentication (oauth/api-key)", "oauth", (value) => {
            const normalized = value.replace("-", "_");
            if (normalized !== "oauth" && normalized !== "api_key") {
              throw new Error("Choose oauth or api-key.");
            }
            return normalized;
          });
      if (configuration.authType === "oauth") {
        presentation?.message(
          "Pi identifies this as Claude Pro/Max authentication; third-party harness traffic may use paid extra usage rather than included plan limits.",
          "warning"
        );
      }
    } else {
      configuration.authType = defaultProviderAuthType(configuration.provider);
    }
    if (configuration.authType === "api_key") {
      configuration.apiKey = await collectProviderSecret(prompter, configuration.provider);
    } else if (
      configuration.provider === "openai-codex" ||
      configuration.provider === "anthropic"
    ) {
      const provider = configuration.provider;
      const detected = (options.detectedLogins ?? []).find((login) => login.provider === provider);
      if (detected) {
        configuration.reuseLogin = { provider, source: detected.source };
        presentation?.message(`Reusing your ${detected.source} sign-in.`, "success");
      }
    }
  }
  return configuration;
};

const updateEnvironment = (contents: string, configuration: SetupConfiguration): string => {
  const values: Record<(typeof SETUP_KEYS)[number], string> = {
    OPENTEAM_TIME_ZONE: configuration.timeZone,
    OPENTEAM_WORKER_CONCURRENCY: configuration.workerConcurrency,
    OPENTEAM_API_PORT: configuration.apiPort,
    OPENTEAM_ACCESS_MODE: configuration.accessMode,
    OPENTEAM_BIND_HOST: configuration.bindHost,
    OPENTEAM_VIEWER_BIND_HOST: configuration.viewerBindHost,
    OPENTEAM_PUBLIC_HOST: configuration.publicHost,
    OPENTEAM_PUBLIC_URL: configuration.publicUrl,
    OPENTEAM_AUTH_URL: configuration.publicUrl,
    COMPOSE_PROFILES: configuration.composeProfiles,
  };
  let updated = contents;
  for (const key of SETUP_KEYS) updated = replaceEnvironmentValue(updated, key, values[key]);
  return updated;
};

const providerUtility = (project: ComposeProject, args: readonly string[], input?: string) =>
  project.run(
    ["run", "--rm", "--no-deps", "--no-TTY", "computer", "openteam-pi-auth", ...args],
    input === undefined ? {} : { input }
  );

const readStoppedRuntimeInference = (project: ComposeProject): RuntimeInferenceSettings => {
  const result = providerUtility(project, ["selection"]);
  if (result.status !== 0) {
    throw new CliError(
      result.stderr.trim() || result.stdout.trim() || "Could not read runtime inference settings"
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new CliError("Runtime inference settings are invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Runtime inference settings are invalid");
  }
  const settings = value as Record<string, unknown>;
  if (
    typeof settings.providerId !== "string" ||
    typeof settings.modelId !== "string" ||
    !THINKING_LEVELS.includes(settings.reasoning as SetupConfiguration["thinking"])
  ) {
    throw new CliError("Runtime inference settings are invalid");
  }
  return settings as unknown as RuntimeInferenceSettings;
};

const registerCustomProvider = (
  project: ComposeProject,
  customProvider: SetupCustomProvider
): void => {
  const result = providerUtility(
    project,
    ["add-custom"],
    JSON.stringify({ ...customProvider, createOnly: true })
  );
  if (result.status !== 0) {
    throw new CliError(
      `Could not configure custom provider ${customProvider.id}: ${result.stderr.trim() || result.stdout.trim() || "provider utility failed"}`
    );
  }
};

const removeRegisteredCustomProvider = (
  project: ComposeProject,
  providerId: string | null
): void => {
  if (providerId) providerUtility(project, ["remove-custom", providerId]);
};

const assertProviderModelAvailable = (
  project: ComposeProject,
  providerId: string,
  modelId: string
): void => {
  const result = providerUtility(project, ["models", providerId]);
  if (result.status !== 0) {
    throw new CliError(
      `Could not inspect Pi provider ${providerId}: ${result.stderr.trim() || result.stdout.trim() || "provider utility failed"}`
    );
  }
  let models: unknown;
  try {
    models = JSON.parse(result.stdout);
  } catch {
    throw new CliError(`Pi returned invalid model metadata for ${providerId}`);
  }
  if (
    !Array.isArray(models) ||
    !models.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "providerId" in candidate &&
        candidate.providerId === providerId &&
        "modelId" in candidate &&
        candidate.modelId === modelId
    )
  ) {
    throw new CliError(
      `Pi does not provide ${providerId}/${modelId}. Choose a model shown by openteam model list ${providerId}.`
    );
  }
};

const configurationSummary = (configuration: SetupConfiguration) => [
  { label: "Access", value: accessLabel(configuration.accessMode) },
  { label: "Address", value: configuration.publicUrl },
  { label: "Owner", value: configuration.ownerUsername },
  {
    label: "Model",
    value: `${configuration.provider}/${configuration.model} · ${configuration.thinking}`,
  },
];

/** Collect a configuration through the sequential prompts, including the apply confirmation. */
const collectThroughPrompts = async (
  prompter: SetupPrompter,
  presentation: SetupPresentation,
  collectOptions: SetupCommandOptions,
  current: ReadonlyMap<string, string>,
  authenticated: boolean,
  ownerUsername: string,
  currentInference: RuntimeInferenceSettings,
  installationDirectory: string,
  notes: ReadonlyArray<{ text: string; tone: MessageTone }>
): Promise<SetupConfiguration | null> => {
  presentation.start();
  presentation.message(`Installation: ${installationDirectory}`, "muted");
  presentation.message("Press Enter to keep the value shown in brackets.", "muted");
  for (const note of notes) presentation.message(note.text, note.tone);
  while (true) {
    const candidate = await collectSetupConfiguration(
      current,
      authenticated,
      prompter,
      collectOptions,
      ownerUsername,
      currentInference
    );

    if (!collectOptions.advanced) {
      presentation.message(
        `Using ${candidate.provider}/${candidate.model}, ${candidate.thinking} reasoning, and local API port ${candidate.apiPort}.`,
        "info"
      );
      presentation.message(
        "Run openteam setup --advanced for port, time-zone, concurrency, and reasoning controls.",
        "muted"
      );
    }

    presentation.stage(3);
    presentation.summary("Configuration ready", configurationSummary(candidate));
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
              { label: "Apply and start OpenTeam", value: "yes", shortcut: "y" },
              { label: "Go back", value: "back", shortcut: "b" },
              { label: "Cancel without changes", value: "no", shortcut: "n" },
            ] as const,
            "yes"
          )
        : (await prompter.question("Apply this configuration? [Y/n/back] ")).trim().toLowerCase();
      if (!answer || answer === "y" || answer === "yes") return candidate;
      if (answer === "n" || answer === "no") return null;
      if (answer === "b" || answer === "back") {
        presentation.message("Returning to the access stage.", "muted");
        break;
      }
      presentation.message("Enter yes, no, or back.", "warning");
    }
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
  const current = new Map(parseEnvironment(previousEnvironment));
  const initialHealth = await checkHealth(paths);
  const running = runningServices(project);
  assertOwnServer(runner, initialHealth, running, current);
  const currentInference = initialHealth.ok
    ? await readRuntimeInferenceSettings(paths)
    : manifest.ownerUsername
      ? readStoppedRuntimeInference(project)
      : DEFAULT_RUNTIME_INFERENCE;
  const prompter = suppliedPrompter || createTerminalPrompter();
  const presentation =
    options.presentation ??
    createSetupPresentation({ version: manifest.version, stages: SETUP_STAGES });
  const fresh = options.fresh ?? !manifest.ownerUsername;
  const detectedPrivateHost = detectPrivateNetworkHost();
  const loginDetection: LoginDetectionOptions = options.loginDetection ?? { runner };
  const detectedLogins = options.detectedLogins ?? detectReusableLogins(loginDetection);
  const previousApiPort = current.get("OPENTEAM_API_PORT");
  const notes: Array<{ text: string; tone: MessageTone }> = [];
  if (fresh && !initialHealth.ok) {
    const configured = Number(current.get("OPENTEAM_API_PORT") || API_PORT);
    const suggested = await suggestApiPort("127.0.0.1", configured);
    if (suggested !== configured) {
      current.set("OPENTEAM_API_PORT", String(suggested));
      notes.push({
        text: `Port ${configured} is already in use; using ${suggested} as the local API default.`,
        tone: "info",
      });
    }
  }
  const collectOptions: SetupCommandOptions = {
    ...options,
    fresh,
    ownerConfigured: Boolean(manifest.ownerUsername),
    presentation,
    detectedPrivateHost,
    detectedLogins,
    loginDetection,
  };
  const authenticated = initialHealth.inference === "ready";
  const ownerUsername = manifest.ownerUsername || "openteam";

  let configuration: SetupConfiguration | null;
  try {
    if (prompter.session) {
      configuration = await prompter.session({
        version: manifest.version,
        stages: SETUP_STAGES,
        current,
        authenticated,
        advanced: collectOptions.advanced,
        fresh,
        ownerConfigured: collectOptions.ownerConfigured,
        currentOwnerUsername: ownerUsername,
        currentInference,
        detectedPrivateHost,
        detectedLogins,
        notes,
      });
      if (configuration) {
        // The session clears itself; leave a settled record of what is being applied.
        presentation.stage(3);
        presentation.message(`Installation: ${paths.directory}`, "muted");
        presentation.summary("Configuration ready", configurationSummary(configuration));
        if (configuration.accessMode === "proxy") {
          presentation.message(
            `Proxy target: http://127.0.0.1:${configuration.apiPort} (WebSocket upgrades must be enabled).`,
            "info"
          );
        }
      }
    } else {
      configuration = await collectThroughPrompts(
        prompter,
        presentation,
        collectOptions,
        current,
        authenticated,
        ownerUsername,
        currentInference,
        paths.directory,
        notes
      );
    }
  } finally {
    if (!suppliedPrompter) prompter.close();
  }
  if (!configuration) {
    presentation.message("Setup cancelled; no configuration was changed.", "muted");
    return;
  }
  // Ports held by our own running services are fine; a changed API port must be free.
  const ownedPorts = new Set(running);
  if (configuration.apiPort !== (previousApiPort || String(API_PORT))) ownedPorts.delete("server");
  await assertPortsAvailable(runner, portRequirementsFromConfiguration(configuration, ownedPorts));
  let registeredCustomProvider: string | null = null;
  try {
    if (configuration.customProvider) {
      presentation.message(
        `Registering custom Pi provider ${configuration.customProvider.id}…`,
        "info"
      );
      registerCustomProvider(project, configuration.customProvider);
      registeredCustomProvider = configuration.customProvider.id;
    }
    assertProviderModelAvailable(project, configuration.provider, configuration.model);

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

    if (changed || configuration.customProvider || !initialHealth.ok || manifest.uninstalledAt) {
      presentation.message(changed ? "Applying configuration…" : "Starting OpenTeam…", "info");
      try {
        if (configuration.accessMode !== "https") {
          // A profile-disabled service is not guaranteed to be removed by `up --remove-orphans`.
          // Stop a previously enabled proxy explicitly when switching away from HTTPS.
          project.run(["stop", "caddy"]);
        }
        project.runOrThrow(["up", "--detach", "--remove-orphans"], { inherit: true });
        process.stdout.write("Waiting for OpenTeam");
        const health = await waitForHealth(paths);
        if (!health.ok) throw new CliError(`OpenTeam did not become healthy: ${health.detail}`);
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
          const recovery = project.run(["up", "--detach", "--remove-orphans"], {
            inherit: true,
          });
          throw new CliError(
            `Setup failed and the previous configuration was restored${
              recovery.status === 0 ? " and restarted" : ", but it could not be restarted"
            }: ${error instanceof Error ? error.message : error}`
          );
        }
        throw error;
      }
    } else {
      presentation.message("Configuration is unchanged.", "success");
    }
  } catch (error) {
    removeRegisteredCustomProvider(project, registeredCustomProvider);
    throw error;
  }

  if (configuration.ownerPassword) {
    presentation.message("Setting the OpenTeam owner credentials…", "info");
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
    presentation.message(
      `OpenTeam sign-in is ready for ${configuration.ownerUsername}.`,
      "success"
    );
  }

  if (configuration.authenticate) {
    presentation.message(`Configuring ${configuration.provider} authentication…`, "info");
    presentation.message(
      "Provider credentials are handled by Pi and are not written to .env.",
      "muted"
    );
    if (configuration.authType === "api_key") {
      project.runOrThrow(
        [
          "exec",
          "--no-TTY",
          "computer",
          "openteam-pi-auth",
          "login",
          configuration.provider,
          "api_key",
        ],
        { input: `${configuration.apiKey}\n` }
      );
      configuration.apiKey = undefined;
    } else {
      let imported = false;
      if (configuration.reuseLogin) {
        const reusable = readReusableCredential(configuration.reuseLogin.provider, loginDetection);
        if (!reusable) {
          presentation.message(
            `The ${configuration.reuseLogin.source} sign-in could not be read; signing in through the browser instead.`,
            "warning"
          );
        } else {
          // Tokens travel over stdin only, like API keys, and never appear in arguments.
          const result = project.run(
            ["exec", "--no-TTY", "computer", "openteam-pi-auth", "import", configuration.provider],
            { input: JSON.stringify(reusable.credential) }
          );
          if (result.status === 0) {
            imported = true;
            presentation.message(`Reused your ${reusable.source} sign-in.`, "success");
          } else {
            presentation.message(
              `Could not reuse the ${reusable.source} sign-in (${result.stderr.trim() || result.stdout.trim() || "import failed"}); signing in through the browser instead.`,
              "warning"
            );
          }
        }
      }
      if (!imported) {
        project.runOrThrow(
          ["exec", "computer", "openteam-pi-auth", "login", configuration.provider, "oauth"],
          { inherit: true }
        );
      }
    }
    presentation.message(`${configuration.provider} authentication is ready.`, "success");
  }

  const nextInference: RuntimeInferenceSettings = {
    providerId: configuration.provider,
    modelId: configuration.model,
    reasoning: configuration.thinking,
  };
  if (
    nextInference.providerId !== currentInference.providerId ||
    nextInference.modelId !== currentInference.modelId ||
    nextInference.reasoning !== currentInference.reasoning
  ) {
    try {
      await writeRuntimeInferenceSettings(paths, nextInference);
    } catch (error) {
      throw new CliError(
        `Could not activate ${configuration.provider}/${configuration.model}. Run openteam provider login ${configuration.provider} and retry: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    presentation.message(
      `${configuration.provider}/${configuration.model} is active for new inference turns.`,
      "success"
    );
  }

  presentation.message("Running OpenTeam doctor…", "info");
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
            ? "Confirm DNS points here and inbound TCP ports 80 and 443 are open, then run openteam doctor."
            : configuration.accessMode === "proxy"
              ? `Confirm your proxy forwards HTTPS and WebSockets to http://127.0.0.1:${configuration.apiPort}, then run openteam doctor.`
              : "Confirm the host, port, and cloud firewall rules, then run openteam doctor."
        }`,
        2
      );
    } else {
      presentation.message(`Public endpoint verified at ${configuration.publicUrl}.`, "success");
    }
  }
  presentation.summary("OpenTeam is ready", [
    { label: "Server", value: configuration.publicUrl },
    { label: "Username", value: configuration.ownerUsername },
    { label: "Security", value: accessLabel(configuration.accessMode) },
    { label: "Manage", value: "openteam status · openteam doctor · openteam update" },
  ]);
};
