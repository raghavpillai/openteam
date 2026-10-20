import { serverInferenceSettings, type ServerInferenceSettings } from "./inference";

export interface ExecutorProfile extends ServerInferenceSettings {
  name: string;
  description: string;
}

export interface TaskConfiguration {
  executorProfiles: ExecutorProfile[];
  defaultExecutorProfile?: string;
  graphicalAvailable?: boolean;
  disabledToolIdentifiers?: string[];
}

export const defaultTaskConfiguration = (): TaskConfiguration => ({
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
          "executorProfiles",
          "defaultExecutorProfile",
          "graphicalAvailable",
          "disabledToolIdentifiers",
          // Retired worker-mode switch, still in saved settings and run snapshots. Ignored.
          "combinedComputerUse",
        ].includes(key)
    )
  )
    throw new Error("Unknown Task setting");
  if (!Array.isArray(value.executorProfiles) || value.executorProfiles.length > 20)
    throw new Error("Choose at most 20 executor profiles");
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
  ...(config.graphicalAvailable === false ? [] : ["computerUse"]),
  "knowledgeWork",
];

/** Workers that run with the parent's connector accounts. */
export const subagentUsesParentConnectors = (subagentType: string | null | undefined): boolean =>
  subagentType === "executor" || subagentType === "knowledgeWork";

export interface TaskCapabilities {
  desktopAvailable: boolean;
  boxAvailable: boolean;
}
export function selectTaskConfiguration(
  config: TaskConfiguration,
  capabilities: TaskCapabilities
): TaskConfiguration {
  return {
    ...config,
    graphicalAvailable:
      config.graphicalAvailable !== false &&
      capabilities.desktopAvailable &&
      capabilities.boxAvailable,
  };
}
export const taskToolEnabled = (config: TaskConfiguration | undefined, tool: string) =>
  !config?.disabledToolIdentifiers?.includes(
    tool === "Computer" ? "OPENAI_COMPUTER_USE" : tool.toUpperCase()
  );

export function taskUserInfo(config = defaultTaskConfiguration()): string {
  const browserCapabilities = [
    ["browser_console_messages", "read browser console errors and warnings without opening native developer tools"],
    ["browser_take_screenshot", "capture page evidence and return the saved file path"],
    ["browser_file_upload", "respond to page file choosers using workspace files"],
  ].filter(([tool]) => taskToolEnabled(config, tool!));
  return [
    "<available_subagent_types>",
    "executor: general delegated work with search, fetch, files and shell; no browser or desktop controls and no nested workers. Supply a self-contained task with all required context and completion criteria. If graphical verification may be needed, route that part to an available graphical worker from the parent.",
    "videoReview and watchVideo: media review.",
    config.graphicalAvailable === false
      ? "Browser and desktop workers are unavailable on this computer."
      : "computerUse: browser and desktop work using structured browser tools and desktop controls on the same persistent box. Only one computerUse worker may run at a time.",
    "knowledgeWork: A higher-powered executor for five kinds of work, and only these: (1) slides and decks (`.pptx`, Google Slides); (2) spreadsheets (`.xlsx`, `.csv`, Google Sheets); (3) written documents (`.docx`, Google Docs, Notion pages); (4) emails; (5) Slack messages. Use it when a skill names it or the deliverable is one of these. Email and Slack messages under the user's name still come back to you to draft. It starts with no context, so give it everything it needs in the prompt. It runs in the background like any Task: you are notified when it finishes, so do not poll or await it. It runs headless and cannot talk to the user; it reports its result back to you, and you deliver it.",
    "</available_subagent_types>",
    ...(config.graphicalAvailable !== false && browserCapabilities.length
      ? ["Browser capabilities of the graphical worker (subject to the task's modality restrictions): " +
          browserCapabilities.map(([tool, capability]) => `${tool}: ${capability}`).join("; ") +
          ". Delegate the required result; the worker can use these tools without additional native UI steps."]
      : []),
  ].join("\n");
}

/** Worker inference is inherited from the server-authored parent run. Neither
 * executor profiles nor Task tool arguments select a worker model or reasoning level. */
export function taskInference(
  _config: TaskConfiguration,
  _input: { subagent_type?: string; model?: string; resume?: string },
  inherited: ServerInferenceSettings
): ServerInferenceSettings {
  return serverInferenceSettings(inherited.providerId, inherited.modelId, inherited.reasoning);
}
