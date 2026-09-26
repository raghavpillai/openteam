import reference from "./tool-reference.json";
import native from "./native-tools.json";
import { defaultTaskConfiguration, taskTypeNames, type TaskConfiguration } from "./task-configuration";

export interface ToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

/** Captured contracts, with explicit product adaptations. Never synthesize schemas
 * from the handler's implementation: the model and the parser have separate jobs. */
const adaptText = (text: string) =>
  text
    .replaceAll("Grok Bot", "OpenTeam")
    .replaceAll("grokbot://", "openteam://")
    .replaceAll("SpaceXAI team", "OpenTeam maintainers")
    .replaceAll("Cursor account", "OpenTeam account")
    .replaceAll("Cursor desktop IDE", "OpenTeam connection settings")
    .replaceAll("other Cursor surfaces", "other bots in this deployment")
    .replaceAll("First-party Cursor tools", "First-party OpenTeam tools")
    .replaceAll("built-in Cursor tools", "built-in OpenTeam tools")
    .replaceAll("Cursor's backend", "the connected desktop")
    .replaceAll("/home/box/agent-data", "/home/box/sand-data");
function adapt(value: any): any {
  if (typeof value === "string") return adaptText(value);
  if (Array.isArray(value)) return value.map(adapt);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, adapt(v)]));
  return value;
}
const contracts: Record<string, ToolContract> = adapt(reference);
// DOM-first observations replace the older capture's implicit screenshots.
// Keep argument schemas unchanged and reserve images for explicit visual tools.
contracts.browser_navigate!.description = contracts.browser_navigate!.description.replace(
  "with a screenshot", "with page text and current element refs. Use browser_take_screenshot for visual evidence"
);
contracts.browser_click!.description = "Click an element by ref from the latest returned page state or browser_snapshot. Scrolls the element into view first. Returns page text and current element refs. Use browser_take_screenshot for visual evidence.";

// Observed text/regex search capability with bounded OpenTeam output.
contracts.browser_find = {
  name: "browser_find",
  description: "Find text in the current rendered page, including non-interactive text, open shadow roots and reachable frames. Supply exactly one of text (case-insensitive literal) or regex (JavaScript pattern or /pattern/flags). Returns matching page lines with nearby context and current actionable refs. Does not click or scroll. Results are bounded; narrow the query if truncated. Hidden content is excluded and private field values remain redacted.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    text: { type: "string", minLength: 1, maxLength: 500 },
    regex: { type: "string", minLength: 1, maxLength: 500 },
    viewId: { type: "string", minLength: 1, maxLength: 120 },
    maxResults: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }, oneOf: [{ required: ["text"] }, { required: ["regex"] }] },
};

// Observed Grok invocation shape; bounded OpenTeam extension, not a captured full schema.
contracts.browser_fill_form = {
  name: "browser_fill_form",
  description: "Fill multiple ordinary form fields in one call using refs from the latest page state. Prefer this over separate fills/clicks for a form. Supports textbox values and explicit checkbox states (true/false), not toggles. Does not submit. Returns per-field outcomes and fresh page state; a failure stops the remaining fields without rolling back completed fields. Use the write-only user form for credentials instead.",
  inputSchema: { type: "object", additionalProperties: false, required: ["fields"], properties: {
    viewId: { type: "string", minLength: 1, maxLength: 120 },
    fields: { type: "array", minItems: 1, maxItems: 20, items: {
      type: "object", additionalProperties: false, required: ["target", "name", "type", "value"], properties: {
        target: { type: "string", pattern: "^e[0-9]+$" },
        name: { type: "string", maxLength: 500 },
        type: { type: "string", enum: ["textbox", "checkbox"] },
        value: { anyOf: [{ type: "string", maxLength: 10000 }, { type: "boolean" }] },
      },
    } },
  } },
};

// OpenTeam implementation of the observed pending-chooser upload capability.
// Keep this explicit adaptation separate from the captured reference document.
contracts.browser_file_upload = {
  name: "browser_file_upload",
  description: "Respond to a pending file chooser opened by a browser click. Upload authorized absolute local paths inside the workspace. Omit paths or pass [] to cancel. Do not use native chooser clicks for an intercepted chooser. File contents and destination remain subject to action review.",
  inputSchema: {type: "object", properties: {
    paths: {type: "array", items: {type: "string", maxLength: 4096}, maxItems: 10},
    viewId: {type: "string", minLength: 1, maxLength: 120},
  }, additionalProperties: false},
};

// OpenTeam supports Google Drive and Gmail transfers. Keep the captured source
// intact while removing the retired provider from the advertised contract.
for (const name of ["upload_file", "download_file"]) {
  contracts[name]!.description = contracts[name]!.description
    .replace("google-drive, onedrive or gmail", "google-drive or gmail")
    .replace(/\n- OneDrive:[^\n]*/, "");
}
delete contracts.upload_file!.inputSchema.properties.destination.properties.overwrite;
const fileSource = contracts.download_file!.inputSchema.properties.source;
delete fileSource.properties.path;
fileSource.required = ["fileId"];
fileSource.description = "Which file to pull, identified by its provider file ID.";
// Updating one existing task is a valid merge, even though a new task list
// should contain multiple steps. Keep the model-facing schema and parser aligned.
contracts.TodoWrite!.inputSchema.properties.todos.minItems = 1;
contracts.TodoWrite!.inputSchema.allOf = [{ anyOf: [
  { properties: { merge: { const: true } } },
  { properties: { todos: { minItems: 2 } } },
] }];
contracts.TodoWrite!.inputSchema.properties.todos.description =
  "Task items to write. A merge update may contain one item; replacing the list requires at least two items.";
for (const excluded of ["CloudAgent", "GenerateImage", "request_scm_connect"])
  contracts.GetDynamicTools!.description = contracts.GetDynamicTools!.description.replaceAll(
    `${excluded}, `,
    ""
  );
const send = contracts.SendToUser!;
export const SEND_TO_USER_BATCH_GUIDANCE =
  "When several separate text replies to the same conversation are fully ready, emit their SendToUser calls together in one assistant response, in display order, instead of waiting for a model round trip between messages. Keep end_turn false until the final call. Do not batch messages whose content depends on a preceding tool result, user input, or approval.";
send.inputSchema.properties.type.enum = send.inputSchema.properties.type.enum.filter(
  (type: string) => type !== "cursor-agent"
);
delete send.inputSchema.properties.bcId;
send.inputSchema.properties.type.description = send.inputSchema.properties.type.description.replace(
  /cursor-agent to reference a Cursor cloud agent by its bcId \(renders as a card that opens the agent in Cursor on click\), /,
  ""
);
send.description = send.description.replace(
  /Use \{"type":"cursor-agent"[^}]*\} to reference a Cursor cloud agent:[\s\S]*?(?=Use \{"type":"widget")/,
  ""
);
// Retain private connector-key requests and personal scope supported by this deployment.
const localSecret = native.native.find((tool) => tool.name === "SendToUser")!.parameters.properties
  .secret!;
send.inputSchema.properties.secret = {
  ...send.inputSchema.properties.secret,
  properties: {
    ...send.inputSchema.properties.secret.properties,
    ...Object.fromEntries(
      Object.entries(localSecret.properties).filter(([key]) =>
        ["connector", "field", "scope"].includes(key)
      )
    ),
  },
  required: ["label"],
  oneOf: [
    {
      required: ["name"],
      not: { anyOf: [{ required: ["connector"] }, { required: ["field"] }] },
    },
    { required: ["connector", "field"], not: { required: ["name"] } },
  ],
};
send.description +=
  " OpenTeam also supports secret {label,connector,field} for connector credentials, and scope:bot|personal for named environment secrets. " + SEND_TO_USER_BATCH_GUIDANCE;
contracts.WebSearch!.description = contracts.WebSearch!.description.replaceAll(
  "2026-09-12",
  new Date().toISOString().slice(0, 10)
);
contracts.WebSearch!.description +=
  " The search provider is chosen in Settings → Providers → Search (Exa, Brave Search, Parallel, Firecrawl, Bing or Perplexity) and its key is stored on the server. Search is off until the user chooses one; the tool then fails with 'Web search is not configured' without making a request or switching providers.";
contracts.WebFetch!.description +=
  " By default OpenTeam's built-in fetcher reads public pages directly (HTML as Markdown, text, JSON, feeds and PDFs, up to 20 MiB, public destinations only; no JavaScript). Settings → Providers → Fetch can switch to Exa, Parallel or Firecrawl, or turn fetch off; the tool then fails with 'Web fetch is turned off' or 'Web fetch is not configured' without making a request.";
export function taskToolContract(config: TaskConfiguration = defaultTaskConfiguration()): ToolContract {
  const tool = structuredClone(contracts.Task!);
  const types = taskTypeNames(config);
  tool.inputSchema.properties.subagent_type.enum = types;
  tool.inputSchema.properties.subagent_type.description = `Subagent type to use for this task. Must be one of: ${types.join(", ")}.`;
  if (config.executorProfiles.length) {
    tool.inputSchema.properties.model = {
      type: "string",
      enum: config.executorProfiles.map(profile => profile.name),
      description: "Optional effort level for a new executor. Choose a listed level based on task difficulty, or omit it for the default. It is ignored for other subagent types and resumed executors.",
    };
    tool.description += "\n\nAvailable model slugs for subagents are listed in <available_subagent_models> in the initial user-info message at the start of this conversation.";
  }
  return tool;
}

export function referenceTool(name: string): ToolContract {
  const contract = contracts[name];
  if (!contract) throw new Error(`No captured tool contract: ${name}`);
  return contract;
}
export function withReferenceContract<
  T extends { name: string; description: string; inputSchema: Record<string, any> },
>(tool: T): T {
  const contract = contracts[tool.name];
  return contract
    ? { ...tool, description: contract.description, inputSchema: contract.inputSchema }
    : tool;
}

export const FIRST_PARTY_NAMESPACE_DESCRIPTION =
  "Native OpenTeam tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them.\n\nHere are some crucial instructions:\n- AuthenticateMcpServer: Start authentication for a connector that needs auth.\n- AwaitShell: Use to sleep and check shell progress. Never sleep using shell.\n- CheckSubagent: Inspect a running background subagent's status and recent actions.\n- CopyFromBox: Copy a file from your box onto the user's computer.\n- CopyToBox: Copy a file from the user's computer onto your box.\n- MessageSubagent: Send a new instruction into a running background subagent.\n- remap_user_form_targets: Only after a request_user_form receipt says a field's value is HELD: remap its new target.\n- request_box_help: Hand your box's desktop to the user for a sign-in or manual step.\n- request_user_form: Show the user an in-chat form; the host fills the box browser with their answers.\n- SearchPlugins: Search installable plugins/connectors when a task needs a service.\n- SendFeedback: Send the user's product feedback to the OpenTeam maintainers when they ask. Ask whether they want a reply unless they already said.\n- StopSubagent: Abort a running background subagent.\n- TodoWrite: Use this tool to manage complex multi-step tasks.";
