import { readFileSync } from "node:fs";
import type { CliOptions } from "./arguments";
import type { InstallationManifest, InstallationPaths } from "./config";
import {
  installationExists,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
} from "./config";
import { PROJECT_NAME } from "./constants";
import { type ComposeProject, requireComposeProject } from "./docker";
import { CliError } from "./errors";
import { waitForHealth } from "./health";
import type { CommandRunner } from "./process";
import { createTerminalPrompter, type SetupPrompter } from "./setup";

type ProviderRow = {
  id: string;
  name: string;
  authMethods: Array<{ type: "oauth" | "api_key"; label: string; subscription: boolean }>;
  configured: boolean;
  authType: "oauth" | "api_key" | null;
  authSource: string | null;
  models: number;
  custom: boolean;
};

type ModelRow = {
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
      `OpenBot is not installed at ${paths.directory}. Run openbot install first.`
    );
  }
  const manifest = readManifest(paths);
  if (!manifest)
    throw new CliError(`OpenBot installation manifest is missing at ${paths.manifest}`);
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
  "openbot-pi-auth",
  ...args,
];

const jsonCommand = <T>(project: ComposeProject, args: readonly string[]): T => {
  const result = project.run(authCommand(args));
  if (result.status !== 0) {
    throw new CliError(
      result.stderr.trim() || result.stdout.trim() || "Pi provider command failed"
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new CliError("Pi provider command returned invalid data");
  }
};

const currentSelection = (paths: InstallationPaths) => {
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  return {
    providerId: environment.get("OPENBOT_PI_PROVIDER") || "openai-codex",
    modelId: environment.get("OPENBOT_PI_MODEL") || "gpt-5.5",
    thinking: environment.get("OPENBOT_PI_THINKING") || "high",
  };
};

const authLabel = (type: string | null): string =>
  type === "api_key" ? "API key" : type === "oauth" ? "OAuth" : "not configured";

export const providerListCommand = (paths: InstallationPaths, runner: CommandRunner): void => {
  const selected = currentSelection(paths).providerId;
  const providers = jsonCommand<ProviderRow[]>(projectFor(paths, runner), ["providers"]);
  for (const provider of providers) {
    const marker = provider.id === selected ? "*" : " ";
    const methods = provider.authMethods.map((method) => method.type.replace("_", " ")).join(", ");
    console.log(
      `${marker} ${provider.id.padEnd(26)} ${provider.name} · ${provider.models} models · ${provider.configured ? authLabel(provider.authType) : methods || "ambient credentials"}`
    );
  }
};

export const modelListCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId?: string
): void => {
  const selected = currentSelection(paths);
  const models = jsonCommand<ModelRow[]>(projectFor(paths, runner), [
    "models",
    ...(providerId ? [providerId] : []),
  ]);
  for (const model of models) {
    const active = model.providerId === selected.providerId && model.modelId === selected.modelId;
    console.log(
      `${active ? "*" : " "} ${model.providerId}/${model.modelId} · ${model.contextWindow.toLocaleString()} context${model.reasoning ? " · reasoning" : ""}${model.input.includes("image") ? " · images" : ""}`
    );
  }
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
  const providerId = options.providerId || currentSelection(paths).providerId;
  const providers = jsonCommand<ProviderRow[]>(project, ["providers"]);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new CliError(`Unknown Pi inference provider: ${providerId}`);
  const prompter = suppliedPrompter || createTerminalPrompter();
  try {
    const authType = await chooseAuthType(provider, options.authType, prompter);
    if (authType === "api_key") {
      const key = (await prompter.secret(`${provider.name} API key or password: `)).trim();
      if (!key) throw new CliError("Provider API key or password cannot be empty");
      project.runOrThrow(authCommand(["login", providerId, "api_key"]), { input: `${key}\n` });
    } else {
      project.runOrThrow(["exec", "computer", "openbot-pi-auth", "login", providerId, "oauth"], {
        inherit: true,
      });
    }
  } finally {
    if (!suppliedPrompter) prompter.close();
  }
};

export const providerLogoutCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId?: string
): void => {
  const selected = currentSelection(paths).providerId;
  const provider = providerId || selected;
  projectFor(paths, runner).runOrThrow(authCommand(["logout", provider]));
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
  console.log(`Use it with: openbot model use ${options.providerId} ${options.modelId}`);
};

export const providerRemoveCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  providerId: string
): void => {
  if (currentSelection(paths).providerId === providerId) {
    throw new CliError("Select a model from another provider before removing the active provider");
  }
  projectFor(paths, runner).runOrThrow(authCommand(["remove-custom", providerId]));
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
  const previous = readFileSync(paths.environment, "utf8");
  let next = replaceEnvironmentValue(previous, "OPENBOT_PI_PROVIDER", providerId);
  next = replaceEnvironmentValue(next, "OPENBOT_PI_MODEL", modelId);
  if (options.thinking)
    next = replaceEnvironmentValue(next, "OPENBOT_PI_THINKING", options.thinking);
  if (next === previous) {
    console.log(`${providerId}/${modelId} is already selected.`);
    return;
  }
  writeFileAtomic(paths.environment, next, 0o600);
  try {
    const validation = project.run(["config", "--quiet"]);
    if (validation.status !== 0) {
      throw new CliError(
        validation.stderr.trim() || validation.stdout.trim() || "Invalid configuration"
      );
    }
    project.runOrThrow(["up", "--detach", "--remove-orphans"], { inherit: true });
    const health = await waitForHealth(paths, 180_000);
    if (!health.ok) throw new CliError(`OpenBot did not become healthy: ${health.detail}`);
  } catch (error) {
    writeFileAtomic(paths.environment, previous, 0o600);
    project.run(["up", "--detach", "--remove-orphans"], { inherit: true });
    throw error;
  }
  console.log(`Selected ${providerId}/${modelId} for Pi inference.`);
};
