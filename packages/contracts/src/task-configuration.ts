import { serverInferenceSettings, type ServerInferenceSettings } from "./inference";

export interface ExecutorProfile extends ServerInferenceSettings {
  name: string;
  description: string;
}

export interface TaskConfiguration {
  combinedComputerUse: boolean;
  executorProfiles: ExecutorProfile[];
  defaultExecutorProfile?: string;
  graphicalAvailable?: boolean;
  disabledToolIdentifiers?: string[];
}

export const defaultTaskConfiguration = (): TaskConfiguration => ({
  combinedComputerUse: true,
  executorProfiles: [],
});

export function parseTaskConfiguration(input: unknown): TaskConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Task settings must be an object");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "combinedComputerUse",
          "executorProfiles",
          "defaultExecutorProfile",
          "graphicalAvailable",
          "disabledToolIdentifiers",
        ].includes(key)
    )
  )
    throw new Error("Unknown Task setting");
  if (
    typeof value.combinedComputerUse !== "boolean" ||
    !Array.isArray(value.executorProfiles) ||
    value.executorProfiles.length > 20
  )
    throw new Error("Choose a computer worker mode and at most 20 executor profiles");
  const names = new Set<string>();
  if (value.graphicalAvailable !== undefined && typeof value.graphicalAvailable !== "boolean")
    throw new Error("Invalid graphical availability");
  if (
    value.disabledToolIdentifiers !== undefined &&
    (!Array.isArray(value.disabledToolIdentifiers) ||
      value.disabledToolIdentifiers.length > 100 ||
      value.disabledToolIdentifiers.some(
        (id) => typeof id !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(id)
      ))
  )
    throw new Error("Invalid disabled tool identifiers");
  const executorProfiles = value.executorProfiles.map((profile): ExecutorProfile => {
    if (
      !profile ||
      typeof profile !== "object" ||
      Array.isArray(profile) ||
      typeof profile.name !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(profile.name) ||
      names.has(profile.name) ||
      typeof profile.description !== "string" ||
      !profile.description.trim() ||
      profile.description.length > 500 ||
      typeof profile.providerId !== "string" ||
      typeof profile.modelId !== "string"
    )
      throw new Error("Executor profiles need unique names, descriptions, and a configured model");
    names.add(profile.name);
    return {
      name: profile.name,
      description: profile.description.trim(),
      ...serverInferenceSettings(profile.providerId, profile.modelId, profile.reasoning),
    };
  });
  if (
    value.defaultExecutorProfile !== undefined &&
    (typeof value.defaultExecutorProfile !== "string" || !names.has(value.defaultExecutorProfile))
  )
    throw new Error("The default executor profile must name one of the configured profiles");
  return {
    combinedComputerUse: value.combinedComputerUse,
    executorProfiles,
    ...(value.graphicalAvailable === undefined
      ? {}
      : { graphicalAvailable: value.graphicalAvailable as boolean }),
    ...(value.disabledToolIdentifiers === undefined
      ? {}
      : { disabledToolIdentifiers: [...new Set(value.disabledToolIdentifiers as string[])] }),
    ...(value.defaultExecutorProfile === undefined
      ? {}
      : { defaultExecutorProfile: value.defaultExecutorProfile as string }),
  };
}

export const taskTypeNames = (config = defaultTaskConfiguration()) => [
  "executor",
  "videoReview",
  "watchVideo",
  ...(config.graphicalAvailable === false
    ? []
    : ["computerUse", ...(config.combinedComputerUse ? [] : ["browserUse"])]),
];

export interface TaskCapabilities {
  desktopAvailable: boolean;
  boxAvailable: boolean;
}
export function selectTaskConfiguration(
  config: TaskConfiguration,
  capabilities: TaskCapabilities
): TaskConfiguration {
  const graphicalAvailable =
    config.graphicalAvailable !== false &&
    capabilities.desktopAvailable &&
    capabilities.boxAvailable;
  const toolsAvailable = !config.disabledToolIdentifiers?.some(
    (id) => id.startsWith("BROWSER_") || ["OPENAI_COMPUTER_USE", "SHELL", "READ"].includes(id)
  );
  return {
    ...config,
    graphicalAvailable,
    combinedComputerUse: config.combinedComputerUse && graphicalAvailable && toolsAvailable,
  };
}
export const taskToolEnabled = (config: TaskConfiguration | undefined, tool: string) =>
  !config?.disabledToolIdentifiers?.includes(
    tool === "Computer" ? "OPENAI_COMPUTER_USE" : tool.toUpperCase()
  );

export function taskUserInfo(config = defaultTaskConfiguration()): string {
  return [
    "<available_subagent_types>",
    "executor: general delegated work. Supply a self-contained task with all required context and completion criteria.",
    "videoReview and watchVideo: media review.",
    config.graphicalAvailable === false
      ? "Browser and desktop workers are unavailable on this computer."
      : config.combinedComputerUse
        ? "computerUse: browser and desktop work using structured browser tools and desktop controls on the same persistent box. Only one computerUse worker may run at a time."
        : "computerUse: desktop interaction and sites that defeat browser automation. Only one computerUse worker may run at a time.\nbrowserUse: structured browser interaction; prefer it for browser-only work.",
    "</available_subagent_types>",
    ...(config.executorProfiles.length
      ? [
          "<available_subagent_models>",
          "Choose an effort level for a new executor, or omit model for the default. It is ignored for other worker types and resumed executors.",
          ...config.executorProfiles.map(
            (profile) =>
              `${profile.name}: ${profile.description}${profile.name === config.defaultExecutorProfile ? " (default)" : ""}`
          ),
          "</available_subagent_models>",
        ]
      : []),
  ].join("\n");
}

/** Model is an executor profile selector, never an arbitrary model override. */
export function taskInference(
  config: TaskConfiguration,
  input: { subagent_type?: string; model?: string; resume?: string },
  inherited: ServerInferenceSettings
): ServerInferenceSettings {
  if (
    input.resume ||
    (input.subagent_type ?? "executor") !== "executor" ||
    !config.executorProfiles.length
  )
    return inherited;
  const name = input.model ?? config.defaultExecutorProfile;
  if (name === undefined) return inherited;
  const profile = config.executorProfiles.find((profile) => profile.name === name);
  if (!profile)
    throw new Error(
      `Unknown executor effort level. Choose ${config.executorProfiles.map((profile) => profile.name).join(", ")}, or omit model.`
    );
  return serverInferenceSettings(profile.providerId, profile.modelId, profile.reasoning);
}
