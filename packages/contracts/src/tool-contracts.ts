import reference from "./tool-reference.json";
import native from "./native-tools.json";

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
for (const excluded of ["CloudAgent", "GenerateImage", "request_scm_connect"])
  contracts.GetDynamicTools!.description = contracts.GetDynamicTools!.description.replaceAll(
    `${excluded}, `,
    ""
  );
const send = contracts.SendToUser!;
send.inputSchema.properties.type.enum = send.inputSchema.properties.type.enum.filter(
  (type: string) => type !== "cursor-agent"
);
delete send.inputSchema.properties.bcId;
send.inputSchema.properties.type.description = send.inputSchema.properties.type.description.replace(
  /cursor-agent to reference a Cursor cloud agent[^.]*\),?\s*/g,
  ""
);
send.description = send.description.replace(
  /Use \{[^\n]*?"cursor-agent"[^\n]*?(?=Use |Set end_turn|$)/g,
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
};
send.description +=
  " OpenTeam also supports secret {label,connector,field} for connector credentials, and scope:bot|personal for named environment secrets.";
contracts.WebSearch!.description = contracts.WebSearch!.description.replaceAll(
  "2026-09-12",
  new Date().toISOString().slice(0, 10)
);
contracts.WebSearch!.description +=
  " The search provider and its API key are configured in Settings and stored in the deployment database. A missing key is reported without silently switching providers.";
contracts.WebFetch!.description +=
  " OpenTeam supports built-in HTTP, Exa Contents, and Tavily Extract through database configuration; the built-in fetch is limited to 5 MiB and public destinations.";
// These are supported local extensions, not missing reference functionality.
contracts.Task!.inputSchema.properties.model = { type: "string" };
if (!contracts.Task!.inputSchema.properties.subagent_type.enum.includes("browserUse"))
  contracts.Task!.inputSchema.properties.subagent_type.enum.unshift("browserUse");
contracts.Task!.inputSchema.properties.subagent_type.description +=
  " OpenTeam also supports browserUse.";
contracts.Task!.description +=
  " browserUse is also available for structured browser interaction. model may select a configured executor model.";

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
