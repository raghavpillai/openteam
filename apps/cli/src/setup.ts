import { readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { installationCommand, renderCommandError } from "./command-ui";
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
import { API_PORT, CLI_VERSION, PROJECT_NAME } from "./constants";
import { requireComposeProject } from "./docker";
import { dockerMissing, renderDockerRequired, startDockerDesktop } from "./docker-preflight";
import { printDoctor, runDoctor, suggestApiPort } from "./doctor";
import { CliError } from "./errors";
import { checkHealth } from "./health";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";
import { printSetupCancelled, waitForAutomaticSetup } from "./setup-countdown";
import { runSetupSession, type SetupSessionInput } from "./setup-session";
import {
  ACCESS_CHOICES,
  ACCESS_MODES,
  accessLabel,
  accessModeNotes,
  bindHostsFor,
  configuredAccessMode,
  detectPrivateNetworkHost,
  existingReachableHost,
  HTTP_WARNINGS,
  publicUrlFor,
  SETUP_STAGES,
  type SetupConfiguration,
  validateAccessMode,
  validateIntegerInRange,
  validateOwnerPassword,
  validateOwnerUsername,
  validateProxyHost,
  validatePublicDomain,
  validatePublicHost,
} from "./setup-values";
import {
  assertOwnServer,
  foreignServerDetected,
  assertPortsAvailable,
  findPortConflict,
  portConflictMessage,
  portRequirementsFromConfiguration,
  runningServices,
} from "./stack";
import { SETUP_JOBS_NOTE, waitForStartup } from "./startup";
import {
  assertTailscaleRouteAvailable,
  detectTailscaleHttps,
  inspectTailscale,
  requireTailscale,
  validateTailscalePort,
  tailscaleHttpsHost,
} from "./tailscale-https";
import {
  cleanManagedTailscaleRoutes,
  ensureManagedTailscaleRoute,
  managedTailscaleRoutes,
  rollbackNewTailscaleRoutes,
} from "./tailscale-state";
import { acquireUpdateLock } from "./update-safety";
import {
  colorEnabled,
  createSetupPresentation,
  type MessageTone,
  renderSelectionPrompt,
  renderSelectionResult,
  type SetupPresentation,
} from "./ui";

export {
  detectPrivateNetworkHost,
  type SetupConfiguration,
  validateOwnerUsername,
} from "./setup-values";

/** Where to get the apps after setup; they connect a model and create the first bot. */
export const APP_DOWNLOADS = [
  { label: "Desktop", value: "https://openteam.so/download" },
  { label: "iPhone", value: "https://testflight.apple.com/join/KFBFPkjP" },
] as const;

const SETUP_KEYS = [
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
  /** Automatic installer handoff; explicit setup starts immediately. */
  countdown?: boolean;
  advanced?: boolean;
  fresh?: boolean;
  /** Download the server images after the questions; defaults to first-time setup. */
  pullImages?: boolean;
  presentation?: SetupPresentation;
  ownerConfigured?: boolean;
  /** Override private-address detection. Primarily useful for deterministic callers and tests. */
  detectedPrivateHost?: string | null;
  preferredHttpsHost?: string;
  tailscaleHost?: string;
  tailscalePort?: string;
  tailscaleIssue?: string | null;
}

export const supportsInteractiveSelection = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => environment.TERM?.toLowerCase() !== "dumb";

/** Ctrl-C reaches Docker Compose too, which stops and exits 130. */
const interrupted = (error: unknown): boolean =>
  error instanceof CliError && error.exitCode === 130;

/** An error's message as a sentence, so advice can follow it. */
const sentence = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

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

// A new account has no default name; changing one offers the current name.
export const collectOwnerUsername = (prompter: SetupPrompter, current: string): Promise<string> =>
  askRequired(prompter, "OpenTeam username", current || null, validateOwnerUsername);

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

/**
 * Sequential prompt flow used by terminals without cursor control and by tests.
 * Interactive terminals run the same questions as a single session instead.
 */
export const collectSetupConfiguration = async (
  current: ReadonlyMap<string, string>,
  prompter: SetupPrompter,
  options: SetupCommandOptions = {},
  currentOwnerUsername = ""
): Promise<SetupConfiguration> => {
  const presentation = options.presentation;
  const advanced = options.advanced ?? false;
  // Tailscale HTTPS is suggested for new installs; a re-run keeps the connection already in use.
  const suggestTailscale = Boolean(options.fresh && options.preferredHttpsHost);
  const currentAccess = suggestTailscale
    ? "tailscale"
    : configuredAccessMode(current, options.fresh ?? false);
  let selectedAccess: SetupConfiguration["accessMode"] = currentAccess;
  {
    presentation?.stage(0);
    while (true) {
      presentation?.choices(ACCESS_CHOICES);
      selectedAccess = prompter.select
        ? await prompter.select(
            "Connection",
            ACCESS_CHOICES.map((choice) => ({ label: choice.title, value: choice.value })),
            currentAccess
          )
        : await ask(
            prompter,
            "Connection",
            String(ACCESS_MODES.indexOf(currentAccess) + 1),
            validateAccessMode
          );
      if (selectedAccess !== "http") break;
      for (const warning of HTTP_WARNINGS) presentation?.message(warning, "warning");
      if (await confirm(prompter, "Continue with public HTTP?", false)) break;
      presentation?.message("Choose a different connection.", "muted");
    }
  }

  const existingHost = options.fresh
    ? (options.preferredHttpsHost ?? null)
    : existingReachableHost(current);
  const detectedPrivateHost =
    options.detectedPrivateHost === undefined
      ? detectPrivateNetworkHost()
      : options.detectedPrivateHost;
  let reachableHost = "127.0.0.1";
  if (selectedAccess === "tailscale") {
    if (options.tailscaleIssue || !(options.tailscaleHost || options.preferredHttpsHost))
      throw new CliError(
        options.tailscaleIssue || "Start Tailscale on the server host, then rerun setup."
      );
    const port = await ask(
      prompter,
      "Tailscale HTTPS port",
      options.tailscalePort ||
        options.preferredHttpsHost?.split(":")[1] ||
        (currentAccess === "tailscale" ? existingHost?.split(":")[1] : null) ||
        "443",
      validateTailscalePort
    );
    reachableHost = tailscaleHttpsHost({
      host: options.tailscaleHost || options.preferredHttpsHost!.split(":")[0]!,
      addresses: [],
      port,
    });
    presentation?.message(`Tailscale HTTPS address: https://${reachableHost}`, "info");
  } else if (selectedAccess === "https" || selectedAccess === "proxy") {
    reachableHost =
      !advanced && selectedAccess === currentAccess && existingHost
        ? existingHost
        : await askRequired(
            prompter,
            "Public domain (A/AAAA record points to this server)",
            existingHost,
            selectedAccess === "proxy" ? validateProxyHost : validatePublicDomain
          );
  } else if (selectedAccess === "http") {
    reachableHost =
      !advanced && selectedAccess === currentAccess && existingHost
        ? existingHost
        : await askRequired(
            prompter,
            "Public hostname or IPv4 address",
            existingHost,
            validatePublicHost
          );
  } else if (selectedAccess === "private") {
    const defaultPrivateHost =
      (selectedAccess === currentAccess ? existingHost : null) || detectedPrivateHost;
    reachableHost =
      advanced || !defaultPrivateHost
        ? await askRequired(
            prompter,
            "Private hostname or IPv4 address",
            defaultPrivateHost,
            validatePublicHost
          )
        : defaultPrivateHost;
  }
  if (advanced) {
    for (const note of accessModeNotes(selectedAccess)) presentation?.message(note.text, note.tone);
  }

  let apiPort = current.get("OPENTEAM_API_PORT") || String(API_PORT);
  let workerConcurrency = current.get("OPENTEAM_WORKER_CONCURRENCY") || "8";
  if (advanced) {
    apiPort = await ask(
      prompter,
      "API port",
      apiPort,
      validateIntegerInRange("API port", 1, 65535)
    );
    workerConcurrency = await ask(
      prompter,
      "Tasks at once",
      workerConcurrency,
      validateIntegerInRange("Tasks at once", 1, 64)
    );
  }

  presentation?.stage(1);
  let ownerUsername = currentOwnerUsername;
  let ownerPassword: string | undefined;
  if (options.ownerConfigured) {
    presentation?.message(
      `Your existing account (${currentOwnerUsername}) will stay signed in.`,
      "success"
    );
    presentation?.message("Run openteam account update if you want to change it.", "muted");
  } else {
    ownerUsername = await collectOwnerUsername(prompter, currentOwnerUsername);
    ownerPassword = await collectConfirmedPassword(prompter);
  }

  return {
    accessMode: selectedAccess,
    ...bindHostsFor(selectedAccess, reachableHost),
    publicUrl: publicUrlFor(selectedAccess, reachableHost, apiPort),
    ownerUsername,
    ownerPassword,
    apiPort,
    workerConcurrency,
  };
};

const updateEnvironment = (contents: string, configuration: SetupConfiguration): string => {
  const values: Record<(typeof SETUP_KEYS)[number], string> = {
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

const configurationSummary = (configuration: SetupConfiguration) => [
  { label: "Connection", value: accessLabel(configuration.accessMode) },
  { label: "Address", value: configuration.publicUrl },
  { label: "Username", value: configuration.ownerUsername },
];

/** Collect a configuration through the sequential prompts, including the apply confirmation. */
const collectThroughPrompts = async (
  prompter: SetupPrompter,
  presentation: SetupPresentation,
  collectOptions: SetupCommandOptions,
  current: ReadonlyMap<string, string>,
  ownerUsername: string,
  installationDirectory: string,
  notes: ReadonlyArray<{ text: string; tone: MessageTone }>,
  check: (configuration: SetupConfiguration) => Promise<string | null>
): Promise<SetupConfiguration | null> => {
  presentation.start();
  presentation.message(`Installation: ${installationDirectory}`, "muted");
  presentation.message("Press Enter to keep the value shown in brackets.", "muted");
  for (const note of notes) presentation.message(note.text, note.tone);
  while (true) {
    const candidate = await collectSetupConfiguration(
      current,
      prompter,
      collectOptions,
      ownerUsername
    );

    presentation.stage(2);
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
              { label: "Start OpenTeam", value: "yes", shortcut: "y" },
              { label: "Go back", value: "back", shortcut: "b" },
              { label: "Cancel without changes", value: "no", shortcut: "n" },
            ] as const,
            "yes"
          )
        : (await prompter.question("Apply this configuration? [Y/n/back] ")).trim().toLowerCase();
      if (!answer || answer === "y" || answer === "yes") {
        // A busy port keeps these answers: fix it and start again, or go back.
        const issue = await check(candidate);
        if (!issue) return candidate;
        presentation.message(issue, "warning");
        continue;
      }
      if (answer === "n" || answer === "no") return null;
      if (answer === "b" || answer === "back") {
        presentation.message("Returning to the connection step.", "muted");
        break;
      }
      presentation.message("Enter yes, no, or back.", "warning");
    }
  }
};

const setupCommandUnlocked = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: SetupCommandOptions = {},
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  const desktop = await startDockerDesktop(runner);
  const prerequisites = await runDoctor(paths, runner, PROJECT_NAME, {
    prerequisitesOnly: true,
  });
  if (!prerequisites.ok) {
    if (dockerMissing(prerequisites)) {
      console.log(
        renderDockerRequired(installationCommand(paths, "setup"), {
          desktopStarting: desktop === "timed-out",
        })
      );
      throw new CliError("Docker is required.", 2, true);
    }
    printDoctor(prerequisites, { compact: true });
    throw new CliError(
      `Setup paused. Fix the failed checks above, then run ${installationCommand(paths, "setup")} again.`,
      2
    );
  }
  const manifest = requireInstallation(paths);
  if (options.countdown && !suppliedPrompter) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new CliError(
        `Run ${installationCommand(paths, "setup")} in an interactive terminal.`,
        2
      );
    if (!(await waitForAutomaticSetup())) {
      printSetupCancelled(paths);
      return;
    }
  }
  const project = requireComposeProject(paths, runner, manifest.projectName || PROJECT_NAME);
  const previousEnvironment = readFileSync(paths.environment, "utf8");
  const current = new Map(parseEnvironment(previousEnvironment));
  const initialHealth = await checkHealth(paths);
  const running = runningServices(project);
  const fresh = options.fresh ?? !manifest.ownerUsername;
  // A new installation can take another port when a different OpenTeam already answers
  // on this one; an existing installation must not move without the owner choosing it.
  const foreignServer = foreignServerDetected(initialHealth, running);
  if (!fresh) assertOwnServer(runner, initialHealth, running, current);
  const ownServerHealthy = initialHealth.ok && !foreignServer;
  const prompter = suppliedPrompter || createTerminalPrompter();
  const presentation =
    options.presentation ?? createSetupPresentation({ version: CLI_VERSION, stages: SETUP_STAGES });
  const detectedPrivateHost =
    options.detectedPrivateHost === undefined
      ? detectPrivateNetworkHost()
      : options.detectedPrivateHost;
  const previousApiPort = current.get("OPENTEAM_API_PORT");
  const notes: Array<{ text: string; tone: MessageTone }> = [];
  if (manifest.version !== CLI_VERSION) {
    notes.push({ text: `Installed server release: v${manifest.version}.`, tone: "muted" });
  }
  if (fresh && !ownServerHealthy) {
    const configured = Number(current.get("OPENTEAM_API_PORT") || API_PORT);
    // The other server holds the configured port even where a loopback probe can still bind.
    const suggested = await suggestApiPort(
      "127.0.0.1",
      foreignServer ? configured + 1 : configured
    );
    if (suggested !== configured) {
      current.set("OPENTEAM_API_PORT", String(suggested));
      notes.push({
        text: `Port ${configured} is already in use; using ${suggested} as the local API default.`,
        tone: "info",
      });
    }
  }
  const tailscaleInspection = inspectTailscale(runner);
  const tailscale = detectTailscaleHttps(
    runner,
    current.get("OPENTEAM_API_PORT") || String(API_PORT)
  );
  const accessMode = configuredAccessMode(current, fresh);
  const privateHost = (fresh ? null : existingReachableHost(current)) ?? detectedPrivateHost;
  const preferredHttpsHost =
    tailscale &&
    ((accessMode === "private" &&
      (!privateHost ||
        privateHost === tailscale.host ||
        tailscale.addresses.includes(privateHost))) ||
      (accessMode === "proxy" &&
        current.get("OPENTEAM_PUBLIC_URL") === `https://${tailscaleHttpsHost(tailscale)}`))
      ? tailscaleHttpsHost(tailscale)
      : undefined;
  if (preferredHttpsHost)
    notes.push({
      text: `Tailscale HTTPS is available at https://${preferredHttpsHost}. If you choose it, setup adds a private Serve route for OpenTeam; keep Tailscale connected on your devices.`,
      tone: "info",
    });
  const collectOptions: SetupCommandOptions = {
    ...options,
    fresh,
    ownerConfigured: Boolean(manifest.ownerUsername),
    detectedPrivateHost,
    preferredHttpsHost,
    tailscaleHost: tailscaleInspection.node?.host,
    tailscalePort:
      accessMode === "tailscale"
        ? new URL(current.get("OPENTEAM_PUBLIC_URL")!).port || "443"
        : tailscale?.port,
    tailscaleIssue: tailscaleInspection.issue,
    presentation,
  };
  const ownerUsername = manifest.ownerUsername || "";
  // Services of this installation may keep their ports; a moved API port must be free.
  const ownedPorts = (configuration: SetupConfiguration): Set<string> => {
    const owned = new Set(running);
    if (configuration.apiPort !== (previousApiPort || String(API_PORT))) owned.delete("server");
    return owned;
  };
  // Run before anything changes, so a conflict sends the user back with their answers.
  const checkStartup = async (configuration: SetupConfiguration): Promise<string | null> => {
    const conflict = await findPortConflict(
      runner,
      portRequirementsFromConfiguration(configuration, ownedPorts(configuration))
    );
    if (conflict) return portConflictMessage(conflict);
    if (configuration.accessMode !== "tailscale") return null;
    try {
      const node = requireTailscale(runner, new URL(configuration.publicUrl).port || "443");
      assertTailscaleRouteAvailable(runner, node, configuration.apiPort);
      return null;
    } catch (error) {
      if (error instanceof CliError) return error.message;
      throw error;
    }
  };

  let configuration: SetupConfiguration | null;
  try {
    if (prompter.session) {
      configuration = await prompter.session({
        version: CLI_VERSION,
        stages: SETUP_STAGES,
        current,
        advanced: collectOptions.advanced,
        fresh,
        ownerConfigured: collectOptions.ownerConfigured,
        currentOwnerUsername: ownerUsername,
        detectedPrivateHost: collectOptions.detectedPrivateHost,
        preferredHttpsHost,
        tailscaleHost: tailscaleInspection.node?.host,
        tailscalePort: collectOptions.tailscalePort,
        tailscaleIssue: tailscaleInspection.issue,
        notes,
        check: checkStartup,
      });
      if (configuration) {
        // The session clears itself; leave a settled record of what is being applied.
        presentation.stage(2);
        presentation.message(`Installation: ${paths.directory}`, "muted");
        presentation.message(`Installed server release: v${manifest.version}`, "muted");
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
        ownerUsername,
        paths.directory,
        notes,
        checkStartup
      );
    }
  } finally {
    if (!suppliedPrompter) prompter.close();
  }
  if (!configuration) {
    presentation.message("Setup cancelled; no configuration was changed.", "muted");
    if (fresh) {
      presentation.message(
        `Run ${installationCommand(paths, "setup")} when you're ready to finish setting up OpenTeam.`,
        "muted"
      );
    }
    return;
  }
  // Check the target before exposing it through Serve; an occupied port may belong to another app.
  presentation.message("Checking startup ports…", "info");
  await assertPortsAvailable(
    runner,
    portRequirementsFromConfiguration(configuration, ownedPorts(configuration))
  );
  const previousRoutes = managedTailscaleRoutes(paths);
  const tailscaleNode =
    configuration.accessMode === "tailscale"
      ? requireTailscale(runner, new URL(configuration.publicUrl).port || "443")
      : null;
  if (tailscaleNode) {
    if (new URL(configuration.publicUrl).hostname !== tailscaleNode.host)
      throw new CliError(
        "The Tailscale hostname changed during setup. Rerun setup to review the new address."
      );
    assertTailscaleRouteAvailable(runner, tailscaleNode, configuration.apiPort);
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

  if (options.pullImages ?? fresh) {
    // All questions are answered; the long download needs no further input.
    presentation.message(
      "Downloading OpenTeam (about 1.5 GB). This can take a few minutes; no more input is needed.",
      "info"
    );
    try {
      project.runOrThrow(["pull"], { inherit: true });
    } catch (error) {
      // Ctrl-C keeps the answers, so the next setup offers them again.
      if (interrupted(error)) throw error;
      if (changed) writeFileAtomic(paths.environment, previousEnvironment, 0o600);
      throw new CliError(
        `Could not download OpenTeam: ${sentence(error)} Check your internet connection, then run ${installationCommand(paths, "setup")} again.`
      );
    }
  }

  if (changed || !ownServerHealthy || manifest.uninstalledAt) {
    presentation.message(changed ? "Applying configuration…" : "Starting OpenTeam…", "info");
    try {
      if (configuration.accessMode !== "https") {
        // A profile-disabled service is not guaranteed to be removed by `up --remove-orphans`.
        // Stop a previously enabled proxy explicitly when switching away from HTTPS.
        project.run(["stop", "caddy"]);
      }
      presentation.message(SETUP_JOBS_NOTE, "info");
      // A first setup recreates its containers: Docker can leave one whose start failed (a busy
      // port) without its network, and starting that one again would never become healthy.
      project.runOrThrow(
        ["up", "--detach", "--remove-orphans", ...(fresh ? ["--force-recreate"] : [])],
        { inherit: true }
      );
      process.stdout.write("Waiting for OpenTeam");
      const health = await waitForStartup(project, paths);
      if (!health.ok) throw new CliError(`OpenTeam did not become healthy: ${health.detail}`);
      presentation.message(
        `Core services are ready at ${health.url.replace(/\/api\/v0\/health$/, "")}`,
        "success"
      );
      if (manifest.uninstalledAt) {
        writeManifest(paths, { ...manifest, uninstalledAt: undefined });
      }
    } catch (error) {
      // Ctrl-C: a first setup keeps its answers; an existing one gets its configuration back.
      if (interrupted(error)) {
        if (changed && !fresh) writeFileAtomic(paths.environment, previousEnvironment, 0o600);
        throw error;
      }
      if (fresh) {
        // A first setup has no earlier server to bring back, only the installer's placeholders.
        if (changed) writeFileAtomic(paths.environment, previousEnvironment, 0o600);
        throw new CliError(
          `OpenTeam did not start: ${sentence(error)} Fix the problem, then run ${installationCommand(paths, "setup")} again.`
        );
      }
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
  if (tailscaleNode) {
    try {
      ensureManagedTailscaleRoute(paths, runner, tailscaleNode, configuration.apiPort);
      const readiness = await inspectPublicReadiness(configuration.publicUrl);
      const failure = [readiness.dns, readiness.endpoint, readiness.tls]
        .filter((check) => check && !check.ok)
        .map((check) => check!.detail)
        .join("; ");
      if (failure) throw new CliError(`Tailscale HTTPS verification failed: ${failure}`);
      presentation.message(
        `Tailscale HTTPS verified at ${configuration.publicUrl}. Reconnect your apps using this address.`,
        "success"
      );
    } catch (error) {
      const cleanupErrors = rollbackNewTailscaleRoutes(paths, runner, previousRoutes);
      writeFileAtomic(paths.environment, previousEnvironment, 0o600);
      const recovery = project.run(["up", "--detach", "--remove-orphans"]);
      throw new CliError(
        `${error instanceof Error ? error.message : error} Previous configuration restored${recovery.status === 0 ? " and restarted" : "; restart failed, run openteam start"}. HTTPS was not enabled.${cleanupErrors.length ? ` Route cleanup needs attention: ${cleanupErrors.join("; ")}` : ""}`,
        2
      );
    }
  }
  cleanManagedTailscaleRoutes(
    paths,
    runner,
    tailscaleNode
      ? {
          host: tailscaleNode.host,
          port: tailscaleNode.port || "443",
          backendPort: configuration.apiPort,
        }
      : undefined
  );

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

  presentation.stage(3);
  presentation.message("Checking the installation…", "info");
  const diagnosis = await runDoctor(paths, runner, manifest.projectName || PROJECT_NAME);
  printDoctor(diagnosis, {
    compact: true,
    // Models are connected in the apps, and the user just chose this connection.
    omit: (check) =>
      check.label === "Inference" || (check.label === "Network exposure" && check.level === "warn"),
  });
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
  ]);
  presentation.next(
    "Next: open the OpenTeam app and sign in with this server and username.",
    APP_DOWNLOADS,
    "The app will help you connect a model and create your first bot."
  );
};

export const setupCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: SetupCommandOptions = {},
  prompter?: SetupPrompter
): Promise<void> => {
  const release = acquireUpdateLock(paths);
  const stopped = new CliError(
    `Setup was interrupted. Run ${installationCommand(paths, "setup")} to finish setting up OpenTeam.`,
    130
  );
  // Ctrl-C while setup waits between Docker commands stops here. During a command, Docker
  // Compose gets it too and exits 130, which ends setup below with the same advice.
  const onInterrupt = () => {
    release();
    console.error(
      renderCommandError(stopped.message, {
        color: colorEnabled(process.env, Boolean(process.stderr.isTTY)),
        width: process.stderr.columns,
      })
    );
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);
  try {
    await setupCommandUnlocked(paths, runner, options, prompter);
  } catch (error) {
    // A Docker command that the same Ctrl-C stopped can fail before the signal is handled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw interrupted(error) ? stopped : error;
  } finally {
    process.off("SIGINT", onInterrupt);
    release();
  }
};
