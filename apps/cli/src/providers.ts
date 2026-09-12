import {
  installationCommand,
  renderModelCatalog,
  renderProviderCatalog,
  renderSummary,
} from "./command-ui";
import { printMessage } from "./terminal";
import type { CliOptions } from "./arguments";
import type { InstallationManifest, InstallationPaths } from "./config";
import { installationExists, readManifest } from "./config";
import { PROJECT_NAME } from "./constants";
import { type ComposeProject, requireComposeProject } from "./docker";
import { CliError } from "./errors";
import type { CommandRunner } from "./process";
import { readRuntimeInferenceSettings, writeRuntimeInferenceSettings } from "./runtime-settings";
import { createTerminalPrompter, type SetupPrompter } from "./setup";

export type ProviderRow = {
  id: string;
  name: string;
  authMethods: Array<{ type: "oauth" | "api_key"; label: string; subscription: boolean }>;
  configured: boolean;
  authType: "oauth" | "api_key" | null;
  authSource: string | null;
  models: number;
  custom: boolean;
};

export type ModelRow = {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
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

const projectFor = (paths: InstallationPaths, runner: CommandRunner): ComposeProject => {
  const manifest = requireInstallation(paths);
  return requireComposeProject(paths, runner, manifest.projectName || PROJECT_NAME);
};

const authCommand = (args: readonly string[]): string[] => [
  "exec",
  "--no-TTY",
  "computer",
  "openteam-pi-auth",
  ...args,
];

const jsonCommand = <T>(project: ComposeProject, args: readonly string[]): T => {
  const result = project.run(authCommand(args));
  if (result.status !== 0) {
    throw new CliError(
      result.stderr.trim() || result.stdout.trim() || "AI provider command failed"
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new CliError("OpenTeam received invalid AI provider data");
  }
};

const currentSelection = (project: ComposeProject) => {
  const selected = jsonCommand<{
    providerId: string;
    modelId: string;
    reasoning: string;
  }>(project, ["selection"]);
  return { ...selected, thinking: selected.reasoning };
};

export const providerListCommand = (paths: InstallationPaths, runner: CommandRunner): void => {
  const project = projectFor(paths, runner);
  const selected = currentSelection(project).providerId;
  const providers = jsonCommand<ProviderRow[]>(project, ["providers"]);
  console.log(renderProviderCatalog(providers, selected, paths));
};

export const modelListCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId?: string
): void => {
  const project = projectFor(paths, runner);
  const selected = currentSelection(project);
  const models = jsonCommand<ModelRow[]>(project, ["models", ...(providerId ? [providerId] : [])]);
  console.log(renderModelCatalog(models, selected, paths, providerId));
};

const chooseAuthType = async (
  provider: ProviderRow,
  requested: string | undefined,
  prompter: SetupPrompter
): Promise<"oauth" | "api_key"> => {
  const normalized = requested?.replace("-", "_");
  if (normalized === "oauth" || normalized === "api_key") {
    if (!provider.authMethods.some((method) => method.type === normalized)) {
      throw new CliError(`${provider.name} does not support ${normalized.replace("_", " ")} login`);
    }
    return normalized;
  }
  if (provider.authMethods.length === 0) {
    throw new CliError(`${provider.name} does not expose an interactive login method`);
  }
  const firstMethod = provider.authMethods[0];
  if (!firstMethod) throw new CliError(`${provider.name} has invalid authentication metadata`);
  if (provider.authMethods.length === 1) return firstMethod.type;
  if (prompter.select) {
    return prompter.select(
      `Authentication for ${provider.name}`,
      provider.authMethods.map((method) => ({
        label: method.label,
        value: method.type,
      })),
      provider.authMethods.find((method) => method.subscription)?.type ?? firstMethod.type
    );
  }
  const answer = (
    await prompter.question(
      `Authentication for ${provider.name} (${provider.authMethods.map((method) => method.type.replace("_", "-")).join("/")}): `
    )
  )
    .trim()
    .replace("-", "_");
  if (answer !== "oauth" && answer !== "api_key") throw new CliError("Choose oauth or api-key");
  return answer;
};

export const providerLoginCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: Pick<CliOptions, "providerId" | "authType"> = {},
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  const project = projectFor(paths, runner);
  const providerId = options.providerId || currentSelection(project).providerId;
  const providers = jsonCommand<ProviderRow[]>(project, ["providers"]);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new CliError(`Unknown AI provider: ${providerId}`);
  const prompter = suppliedPrompter || createTerminalPrompter();
  try {
    const authType = await chooseAuthType(provider, options.authType, prompter);
    if (authType === "api_key") {
      const key = (await prompter.secret(`${provider.name} API key or password: `)).trim();
      if (!key) throw new CliError("Provider API key or password cannot be empty");
      project.runOrThrow(authCommand(["login", providerId, "api_key"]), { input: `${key}\n` });
    } else {
      if (providerId === "openai-codex") {
        printMessage("If you are connected over SSH, choose Device code login at the next prompt.");
      }
      project.runOrThrow(["exec", "computer", "openteam-pi-auth", "login", providerId, "oauth"], {
        inherit: true,
      });
    }
  } finally {
    if (!suppliedPrompter) prompter.close();
  }
  const connected = jsonCommand<ProviderRow[]>(project, ["providers"]).some(
    (candidate) => candidate.id === providerId && candidate.configured
  );
  if (!connected) {
    throw new CliError(
      `${provider.name} sign-in did not complete. Retry openteam provider login ${providerId} in an interactive terminal and finish the provider sign-in.`,
      2
    );
  }
  console.log(
    renderSummary(
      "provider",
      "CONNECTED",
      [{ label: "Provider", value: `${provider.name} (${providerId})` }],
      [{ text: installationCommand(paths, `model list ${providerId}`), tone: "info" }]
    )
  );
};

export const providerLogoutCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId?: string
): void => {
  const project = projectFor(paths, runner);
  const selected = currentSelection(project).providerId;
  const provider = providerId || selected;
  project.runOrThrow(authCommand(["logout", provider]));
  printMessage(`Removed the saved sign-in for ${provider}.`, "success");
};

export const providerAddCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: CliOptions,
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  const project = projectFor(paths, runner);
  const input = {
    id: options.providerId,
    name: options.providerName,
    baseUrl: options.baseUrl,
    api: options.apiProtocol,
    model: options.modelId,
    reasoning: options.reasoning === true,
    ...(options.contextWindow ? { contextWindow: Number(options.contextWindow) } : {}),
    ...(options.maxTokens ? { maxTokens: Number(options.maxTokens) } : {}),
  };
  project.runOrThrow(authCommand(["add-custom"]), { input: JSON.stringify(input) });
  await providerLoginCommand(
    paths,
    runner,
    { providerId: options.providerId, authType: "api_key" },
    suppliedPrompter
  );
  printMessage(
    `Use it with: ${installationCommand(paths, `model use ${options.providerId} ${options.modelId}`)}`
  );
};

export const providerRemoveCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId: string
): void => {
  const project = projectFor(paths, runner);
  if (currentSelection(project).providerId === providerId) {
    throw new CliError("Select a model from another provider before removing the active provider");
  }
  project.runOrThrow(authCommand(["remove-custom", providerId]));
  printMessage(`Removed custom provider ${providerId}.`, "success");
};

export const modelUseCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: Pick<CliOptions, "providerId" | "modelId" | "thinking">
): Promise<void> => {
  const providerId = options.providerId;
  const modelId = options.modelId;
  if (!providerId || !modelId)
    throw new CliError("Selecting a model requires a provider and model id");
  const project = projectFor(paths, runner);
  project.runOrThrow(authCommand(["verify", providerId, modelId]));
  const current = await readRuntimeInferenceSettings(paths, providerId);
  if (
    options.thinking &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)
  ) {
    throw new CliError(`Invalid reasoning level: ${options.thinking}`);
  }
  const reasoning = (options.thinking || current.reasoning) as typeof current.reasoning;
  if (
    current.providerId === providerId &&
    current.modelId === modelId &&
    current.reasoning === reasoning
  ) {
    console.log(
      renderSummary(
        "model",
        "ALREADY SELECTED",
        [
          { label: "Model", value: `${providerId}/${modelId}` },
          { label: "Thinking", value: reasoning },
        ],
        [{ text: "This model and thinking level are already selected.", tone: "success" }]
      )
    );
    return;
  }
  await writeRuntimeInferenceSettings(paths, { providerId, modelId, reasoning });
  console.log(
    renderSummary(
      "model",
      "MODEL SELECTED",
      [
        { label: "Model", value: `${providerId}/${modelId}` },
        { label: "Thinking", value: reasoning },
      ],
      [{ text: "Ready for new tasks.", tone: "success" }]
    )
  );
};
