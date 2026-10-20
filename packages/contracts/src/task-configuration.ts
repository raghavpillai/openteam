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

const BACKGROUND_TASK = "It runs in the background like any Task: you are notified when it finishes, so do not poll or await it.";

export function taskUserInfo(config = defaultTaskConfiguration()): string {
  const graphical = config.graphicalAvailable !== false;
  return [
    "<available_subagent_types>",
    [
      "executor: Your workhorse: a background subagent with your full work toolset (Shell, box tools, web and MCP tools) that executes one stream of work while you stay available to the user.",
      "Reuse or resume an idle executor for new work in the same workstream. Typically you'll use one or two active executors; four is a soft maximum unless the user is explicitly multitasking or requests parallel threads.",
      "It starts with no context. The dispatch prompt must be self-contained: the goal, the specifics, relevant conversation context, any of your memories or user preferences that matter, explicit success criteria, and what to report back.",
      BACKGROUND_TASK,
      "It runs headless and cannot talk to the user; it reports its result back to you, and you deliver it. It has no browser, desktop, or subagent tools.",
      ...(graphical ? ["It cannot use or dispatch computerUse, so dispatch browser and desktop work to computerUse yourself."] : []),
    ].join(" "),
    "videoReview and watchVideo: media review.",
    graphical
      ? [
          "computerUse: Delegate a self-contained browser or desktop task to a background subagent that operates your box's browser and desktop: websites, GUI apps, file dialogs, and drag interactions. It shares the box browser's persistent logins.",
          "Display is 1280×800. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..1279 × 0..799.",
          BACKGROUND_TASK,
          "It runs headless and cannot ask follow-ups, so give it a tightly-scoped, self-contained task, the smallest concrete step rather than a sprawling goal, with the specifics it needs (site, account, exact values), explicit success criteria and stopping point, and what to report back; break a big goal into several narrow dispatches, and if one runs long or loops, steer it with MessageSubagent or stop it with StopSubagent.",
          "Only one computerUse subagent can run at a time, because they share your desktop's single screen. Never dispatch a second while one is still running.",
          // Workers enter the credentials, codes and card details they are given or can read themselves.
          "At a sign-in, a one-time code, or a card field it uses what your task gives it or what it can read from the user's connected sources; when it has nothing to enter, it stops and reports the exact current URL, and you get what it needs, then dispatch it again.",
          "A captcha is not a human step: it attempts every one itself, whether a checkbox, a puzzle or an image challenge, and stops only after it tried and could not get past it.",
          "A press-and-hold I'm-human button is a mouse hold, not a human step: it holds it with Computer click holdDurationMs until the widget completes.",
        ].join(" ")
      : "Browser and desktop workers are unavailable on this computer.",
    "knowledgeWork: A higher-powered executor for five kinds of work, and only these: (1) slides and decks (`.pptx`, Google Slides); (2) spreadsheets (`.xlsx`, `.csv`, Google Sheets); (3) written documents (`.docx`, Google Docs, Notion pages); (4) emails; (5) Slack messages. Use it when a skill names it or the deliverable is one of these. Email and Slack messages under the user's name still come back to you to draft. It starts with no context, so give it everything it needs in the prompt. " +
      BACKGROUND_TASK +
      " It runs headless and cannot talk to the user; it reports its result back to you, and you deliver it.",
    "</available_subagent_types>",
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
