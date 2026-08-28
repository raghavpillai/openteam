import { Schema } from "effect";
import cursorToolsDocument from "./cursor-tools.json";
import nativeToolsDocument from "./native-tools.json";

export * from "./bot-avatar";

export interface NativeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const observedNativeTools = nativeToolsDocument.native as NativeToolDefinition[];

export const NATIVE_TOOLS = observedNativeTools.map((definition) => {
  return {
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
  };
});

const nativeTool = <const Name extends string>(name: Name) => {
  const definition = NATIVE_TOOLS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing native tool definition: ${name}`);
  return { ...definition, name };
};

/** The attachment's native catalog. */
export const NATIVE_TOOL_NAMES = NATIVE_TOOLS.map(({ name }) => name);

export interface CursorToolDefinition {
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The explicitly supported Cursor-compatible subset; no other Cursor tools are exposed. */
export const CURSOR_TOOLS = cursorToolsDocument.cursor as CursorToolDefinition[];
export const CURSOR_TOOL_NAMES = CURSOR_TOOLS.map(({ tool }) => tool);

const cursorTool = <const Name extends string>(name: Name) => {
  const definition = CURSOR_TOOLS.find((candidate) => candidate.tool === name);
  if (!definition) throw new Error(`Missing Cursor-compatible tool definition: ${name}`);
  return { name, description: definition.description, inputSchema: definition.inputSchema };
};

export const BotStatus = Schema.Literal("provisioning", "active", "archived", "failed");
export type BotStatus = typeof BotStatus.Type;

export const OnboardingStatus = Schema.Literal(
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped_by_user"
);
export type OnboardingStatus = typeof OnboardingStatus.Type;

export const ConversationContinuity = Schema.Literal("empty", "attached", "detached");
export type ConversationContinuity = typeof ConversationContinuity.Type;

export const RunStatus = Schema.Literal(
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
);
export type RunStatus = typeof RunStatus.Type;

export const MessageRole = Schema.Literal("user", "assistant", "system");
export type MessageRole = typeof MessageRole.Type;

export const ChannelKind = Schema.Literal("bot_dm", "agent_dm", "group");
export type ChannelKind = typeof ChannelKind.Type;

export const ChannelMessageSender = Schema.Literal("user", "agent", "system");
export type ChannelMessageSender = typeof ChannelMessageSender.Type;

export const RunOrigin = Schema.Literal("user", "agent", "group", "bootstrap", "routine");
export type RunOrigin = typeof RunOrigin.Type;

export const RunItemKind = Schema.Literal(
  "agent_message",
  "reasoning",
  "command",
  "file_change",
  "tool",
  "compaction",
  "error"
);
export type RunItemKind = typeof RunItemKind.Type;

export const ApprovalDecision = Schema.Literal("accept", "decline", "cancel");
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const CreateBotInput = Schema.Struct({
  clientRequestId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(120)),
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))),
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(120))),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  instructions: Schema.optional(Schema.String.pipe(Schema.maxLength(20_000))),
  icon: Schema.optional(Schema.String.pipe(Schema.maxLength(16))),
  color: Schema.optional(Schema.String.pipe(Schema.pattern(/^#[0-9a-fA-F]{6}$/))),
  notificationsEnabled: Schema.optional(Schema.Boolean),
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))),
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(120))),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  instructions: Schema.optional(Schema.String.pipe(Schema.maxLength(20_000))),
  icon: Schema.optional(Schema.String.pipe(Schema.maxLength(16))),
  color: Schema.optional(Schema.String.pipe(Schema.pattern(/^#[0-9a-fA-F]{6}$/))),
  notificationsEnabled: Schema.optional(Schema.Boolean),
  hiddenFromSidebar: Schema.optional(Schema.Boolean),
});
export type UpdateBotInput = typeof UpdateBotInput.Type;

export const InlineImageInput = Schema.Struct({
  url: Schema.String.pipe(
    Schema.maxLength(28_000_000),
    Schema.pattern(/^data:image\/(?:gif|jpeg|png|webp);base64,/i)
  ),
  alt: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
});
export type InlineImageInput = typeof InlineImageInput.Type;

export const SendMessageInput = Schema.Struct({
  content: Schema.String.pipe(Schema.maxLength(200_000)),
  clientId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(120)),
  replyToMessageId: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))),
  richText: Schema.optional(Schema.String.pipe(Schema.maxLength(400_000))),
  isFork: Schema.optional(Schema.Boolean),
  images: Schema.optional(Schema.Array(InlineImageInput).pipe(Schema.maxItems(8))),
  timeZone: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100))),
}).pipe(
  Schema.filter(
    (input) =>
      (input.content.trim().length > 0 || Boolean(input.images?.length)) &&
      (!input.isFork || Boolean(input.replyToMessageId)),
    {
      message: () => "A message needs text or an image, and a thread reply needs a reply target",
    }
  )
);
export type SendMessageInput = typeof SendMessageInput.Type;

export const ReactToChannelMessageInput = Schema.Struct({
  emoji: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
  clientId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(120)),
  timeZone: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100))),
});
export type ReactToChannelMessageInput = typeof ReactToChannelMessageInput.Type;

export const CreateGroupInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  botIds: Schema.Array(Schema.String).pipe(Schema.minItems(1), Schema.maxItems(6)),
});
export type CreateGroupInput = typeof CreateGroupInput.Type;

export const SetChannelMembersInput = Schema.Struct({
  botIds: Schema.Array(Schema.String).pipe(Schema.minItems(1), Schema.maxItems(6)),
  clientId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(120)),
});
export type SetChannelMembersInput = typeof SetChannelMembersInput.Type;

export const RenameChannelInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  clientId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(120)),
  timeZone: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100))),
});
export type RenameChannelInput = typeof RenameChannelInput.Type;

export const TodoStatus = Schema.Literal("pending", "in_progress", "completed", "cancelled");
export type TodoStatus = typeof TodoStatus.Type;

export const TodoWriteInput = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      content: Schema.String,
      status: TodoStatus,
    })
  ).pipe(Schema.minItems(2)),
  merge: Schema.Boolean,
});
export type TodoWriteInput = typeof TodoWriteInput.Type;

export const SubagentType = Schema.Literal(
  "executor",
  "videoReview",
  "watchVideo",
  "computerUse",
  "browserUse"
);
export type SubagentType = typeof SubagentType.Type;

export const TaskInput = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  model: Schema.optional(Schema.String),
  resume: Schema.optional(Schema.String),
  subagent_type: Schema.optional(SubagentType),
  file_attachments: Schema.optional(Schema.Array(Schema.String)),
  run_in_background: Schema.optional(Schema.Boolean),
});
export type TaskInput = typeof TaskInput.Type;

export const CheckSubagentInput = Schema.Struct({
  subagent_id: Schema.optional(Schema.String),
});
export type CheckSubagentInput = typeof CheckSubagentInput.Type;

export const MessageSubagentInput = Schema.Struct({
  subagent_id: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.String.pipe(Schema.minLength(1)),
});
export type MessageSubagentInput = typeof MessageSubagentInput.Type;

export const StopSubagentInput = Schema.Struct({
  subagent_id: Schema.String.pipe(Schema.minLength(1)),
});
export type StopSubagentInput = typeof StopSubagentInput.Type;

export const CreateAgentInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.optional(Schema.String),
});
export type CreateAgentInput = typeof CreateAgentInput.Type;

export const UpdateAgentInput = Schema.Struct({
  agent_id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type UpdateAgentInput = typeof UpdateAgentInput.Type;

export const CreateChannelInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  member_ids: Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(Schema.minItems(1)),
});
export type CreateChannelInput = typeof CreateChannelInput.Type;

export const UpdateChannelInput = Schema.Struct({
  channel_id: Schema.String.pipe(Schema.minLength(1)),
  add_member_ids: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
  remove_member_ids: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
});
export type UpdateChannelInput = typeof UpdateChannelInput.Type;

export const AgentImageInput = Schema.Struct({
  url: Schema.String.pipe(Schema.minLength(1)),
  alt: Schema.optional(Schema.String),
});
export type AgentImageInput = typeof AgentImageInput.Type;

export const SendToAgentInput = Schema.Struct({
  target_id: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.String.pipe(Schema.minLength(1)),
  images: Schema.optional(Schema.Array(AgentImageInput)),
  priority: Schema.optional(Schema.Boolean),
});
export type SendToAgentInput = typeof SendToAgentInput.Type;

export const AgentSendToUserInput = Schema.Struct({
  type: Schema.Literal("text", "attachment", "widget", "cursor-agent", "secret-request"),
  content: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  alt: Schema.optional(Schema.String),
  images: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        alt: Schema.optional(Schema.String),
      })
    )
  ),
  reply_to: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  to: Schema.optional(Schema.Literal("dm")),
  bcId: Schema.optional(Schema.String),
  widget: Schema.optional(
    Schema.Struct({
      prompt: Schema.String,
      helpText: Schema.optional(Schema.String),
      multiSelect: Schema.optional(Schema.Boolean),
      allowCustom: Schema.optional(Schema.Boolean),
      dismissOnMoveOn: Schema.optional(Schema.Boolean),
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          value: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
          style: Schema.optional(Schema.Literal("default", "primary", "danger")),
        })
      ).pipe(Schema.minItems(1), Schema.maxItems(6)),
    })
  ),
  secret: Schema.optional(
    Schema.Struct({
      label: Schema.String,
      connector: Schema.String,
      field: Schema.String,
      description: Schema.optional(Schema.String),
    })
  ),
});
export type AgentSendToUserInput = typeof AgentSendToUserInput.Type;

export const ReactToMessageInput = Schema.Struct({
  message_address: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  emoji: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16)),
});
export type ReactToMessageInput = typeof ReactToMessageInput.Type;

export const ShellToolInput = Schema.Struct({
  command: Schema.String,
  block_until_ms: Schema.optional(Schema.Number.pipe(Schema.between(0, 7_140_000))),
  description: Schema.optional(Schema.String),
  working_directory: Schema.optional(Schema.String),
  request_smart_mode_approval: Schema.optional(Schema.Boolean),
  smart_mode_block_reason: Schema.optional(Schema.String),
});
export type ShellToolInput = typeof ShellToolInput.Type;

export const ReadToolInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optional(Schema.Number.pipe(Schema.int())),
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
});
export type ReadToolInput = typeof ReadToolInput.Type;

export const GetDynamicToolsInput = Schema.Struct({
  namespace: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
  toolName: Schema.optional(Schema.String),
});
export type GetDynamicToolsInput = typeof GetDynamicToolsInput.Type;

export const CallDynamicToolInput = Schema.Struct({
  namespace: Schema.String,
  toolName: Schema.String,
  arguments: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  mcpDetails: Schema.optional(Schema.Unknown),
});
export type CallDynamicToolInput = typeof CallDynamicToolInput.Type;

export const PluginToolDescriptor = Schema.Struct({
  connectionId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  source: Schema.String,
});
export type PluginToolDescriptor = typeof PluginToolDescriptor.Type;

export const PluginDynamicNamespace = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  namespaceStatus: Schema.Literal("ready", "needsAuth", "error", "loading"),
  tools: Schema.Array(PluginToolDescriptor),
});
export type PluginDynamicNamespace = typeof PluginDynamicNamespace.Type;

export const InstallPluginInput = Schema.Struct({
  pluginKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160)),
});
export type InstallPluginInput = typeof InstallPluginInput.Type;

export const AddCustomMcpInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(100)),
  url: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(2_000)),
  alias: Schema.optional(Schema.String.pipe(Schema.minLength(2), Schema.maxLength(80))),
});
export type AddCustomMcpInput = typeof AddCustomMcpInput.Type;

export const ConnectPluginInput = Schema.Struct({
  alias: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))),
});
export type ConnectPluginInput = typeof ConnectPluginInput.Type;

export const SetPluginGrantInput = Schema.Struct({
  botId: Schema.String,
  enabled: Schema.Boolean,
});
export type SetPluginGrantInput = typeof SetPluginGrantInput.Type;

export const SetPluginEnablementInput = Schema.Struct({
  botId: Schema.String,
  enabled: Schema.Boolean,
  skillsEnabled: Schema.optional(Schema.Boolean),
});
export type SetPluginEnablementInput = typeof SetPluginEnablementInput.Type;

export const SetPluginToolPolicyInput = Schema.Struct({
  botId: Schema.NullOr(Schema.String),
  toolName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  decision: Schema.Literal("deny", "prompt", "allow"),
});
export type SetPluginToolPolicyInput = typeof SetPluginToolPolicyInput.Type;

export interface PluginCatalogToolView {
  name: string;
  description: string;
  risk: "read" | "write" | "destructive";
  defaultDecision: "deny" | "prompt" | "allow";
}

export interface PluginCatalogConnectionView {
  key: string;
  name: string;
  transport: "http" | "stdio" | "builtin";
  auth: "none" | "oauth" | "token";
  tools: PluginCatalogToolView[];
}

export interface PluginCatalogSkillView {
  name: string;
  description: string;
}

export interface PluginCatalogItemView {
  key: string;
  version: string;
  name: string;
  description: string;
  publisher: string;
  category: string;
  featured: boolean;
  installed: boolean;
  components: Array<"skills" | "mcp">;
  connections: PluginCatalogConnectionView[];
  skills: PluginCatalogSkillView[];
}

export interface PluginConnectionView {
  id: string;
  pluginKey: string;
  connectorKey: string;
  name: string;
  alias: string;
  transport: "http" | "stdio" | "builtin";
  auth: "none" | "oauth" | "token";
  status: "disconnected" | "needs_auth" | "ready" | "error" | "revoked";
  statusMessage: string | null;
  instructions: string;
  tools: PluginCatalogToolView[];
  grantedBotIds: string[];
}

export interface PluginInstallView {
  id: string;
  pluginKey: string;
  version: string;
  name: string;
  description: string;
  publisher: string;
  status: "installed" | "disabled" | "error";
  installedAt: string;
  enabledBotIds: string[];
  hasSkills: boolean;
  connections: PluginConnectionView[];
}

export interface PluginActivityView {
  id: string;
  pluginKey: string | null;
  connectionId: string | null;
  botId: string | null;
  kind: string;
  summary: string;
  createdAt: string;
}

export interface PluginSettingsView {
  catalog: PluginCatalogItemView[];
  installs: PluginInstallView[];
  connections: PluginConnectionView[];
  bots: Array<{ id: string; name: string; icon: string; color: string }>;
  policies: Array<{
    id: string;
    connectionId: string;
    botId: string | null;
    toolName: string;
    decision: "deny" | "prompt" | "allow";
  }>;
  activity: PluginActivityView[];
}

export const ScreenActionInput = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("move"),
    x: Schema.Number.pipe(Schema.int(), Schema.between(0, 1279)),
    y: Schema.Number.pipe(Schema.int(), Schema.between(0, 799)),
  }),
  Schema.Struct({
    action: Schema.Literal("click"),
    x: Schema.Number.pipe(Schema.int(), Schema.between(0, 1279)),
    y: Schema.Number.pipe(Schema.int(), Schema.between(0, 799)),
    button: Schema.optional(Schema.Literal("left", "middle", "right")),
    double: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("type"),
    text: Schema.String.pipe(Schema.maxLength(10_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("key"),
    keys: Schema.Array(
      Schema.String.pipe(
        Schema.minLength(1),
        Schema.maxLength(40),
        Schema.pattern(/^[A-Za-z0-9_+-]+$/)
      )
    ).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    deltaY: Schema.Number.pipe(Schema.int(), Schema.between(-20, 20)),
  }),
  Schema.Struct({
    action: Schema.Literal("open_app"),
    app: Schema.Literal("chromium", "thunar", "terminal"),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    ms: Schema.Number.pipe(Schema.int(), Schema.between(0, 10_000)),
  })
);
export type ScreenActionInput = typeof ScreenActionInput.Type;

const ComputerUseActionName = Schema.Literal(
  "screenshot",
  "click",
  "move",
  "drag",
  "type",
  "key",
  "scroll",
  "wait"
);
const ComputerUseModifier = Schema.Literal(
  "shift",
  "ctrl",
  "alt",
  "meta",
  "ctrl+shift",
  "ctrl+alt",
  "meta+shift"
);
const ComputerUsePoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.int(), Schema.between(0, 1279)),
  y: Schema.Number.pipe(Schema.int(), Schema.between(0, 799)),
});
const ComputerUseActionFields = {
  action: ComputerUseActionName,
  x: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 1279))),
  y: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 799))),
  x2: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 1279))),
  y2: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 799))),
  path: Schema.optional(
    Schema.Array(ComputerUsePoint).pipe(Schema.minItems(2), Schema.maxItems(100))
  ),
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(10_000))),
  key: Schema.optional(
    Schema.String.pipe(
      Schema.minLength(1),
      Schema.maxLength(80),
      Schema.pattern(/^[A-Za-z0-9_+-]+$/)
    )
  ),
  button: Schema.optional(Schema.Literal("left", "right", "middle")),
  count: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 3))),
  modifiers: Schema.optional(ComputerUseModifier),
  direction: Schema.optional(Schema.Literal("up", "down", "left", "right")),
  amount: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 20))),
  durationMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 10_000))),
};

const validComputerUseAction = (input: {
  action: typeof ComputerUseActionName.Type;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  path?: ReadonlyArray<{ x: number; y: number }>;
  text?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  durationMs?: number;
}): boolean => {
  const coordinatePair = (input.x === undefined) === (input.y === undefined);
  switch (input.action) {
    case "screenshot":
      return true;
    case "click":
    case "move":
      return coordinatePair;
    case "drag":
      return Boolean(
        (input.path && input.path.length >= 2) ||
          (input.x !== undefined &&
            input.y !== undefined &&
            input.x2 !== undefined &&
            input.y2 !== undefined)
      );
    case "type":
      return input.text !== undefined;
    case "key":
      return input.key !== undefined;
    case "scroll":
      return coordinatePair && input.direction !== undefined;
    case "wait":
      return input.durationMs !== undefined;
  }
};

export const ComputerUseActionInput = Schema.Struct(ComputerUseActionFields).pipe(
  Schema.filter(validComputerUseAction, {
    message: () => "Invalid fields for the selected Computer action",
  })
);
export type ComputerUseActionInput = typeof ComputerUseActionInput.Type;

export const ComputerUseInput = Schema.Struct({
  ...ComputerUseActionFields,
  then: Schema.optional(
    Schema.Array(ComputerUseActionInput).pipe(
      Schema.minItems(1),
      Schema.maxItems(9),
      Schema.filter((actions) => actions.every((action) => action.action !== "screenshot"), {
        message: () => "Batched follow-up actions cannot take intermediate screenshots",
      })
    )
  ),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
}).pipe(
  Schema.filter(validComputerUseAction, {
    message: () => "Invalid fields for the selected Computer action",
  })
);
export type ComputerUseInput = typeof ComputerUseInput.Type;

export const ScreenTakeoverInput = Schema.Struct({ active: Schema.Boolean });
export type ScreenTakeoverInput = typeof ScreenTakeoverInput.Type;

export const ScreenPauseInput = Schema.Struct({ paused: Schema.Boolean });
export type ScreenPauseInput = typeof ScreenPauseInput.Type;

export interface ScreenStatusView {
  botId: string;
  state: "starting" | "ready" | "failed";
  width: number;
  height: number;
  display: number;
  viewerUrl: string;
  humanTakeover: boolean;
  agentInputPaused: boolean;
  apps: Array<"chromium" | "thunar" | "terminal">;
  browserProfileScope: "bot";
  browserSessionScope: "computer";
  browserSessionMechanism: "cookie-broker";
}

export const SEND_TO_AGENT_TOOL = cursorTool("SendToAgent");

export const SEND_TO_USER_TOOL = nativeTool("SendToUser");
export const REACT_TO_MESSAGE_TOOL = nativeTool("ReactToMessage");
export const EXTERNAL_SHELL_TOOL = nativeTool("ExternalShell");
export const EXTERNAL_READ_TOOL = nativeTool("ExternalRead");
export const SHELL_TOOL = nativeTool("Shell");
export const READ_TOOL = nativeTool("Read");
export const GET_DYNAMIC_TOOLS_TOOL = nativeTool("GetDynamicTools");
export const CALL_DYNAMIC_TOOL_TOOL = nativeTool("CallDynamicTool");

export const CHECK_SUBAGENT_TOOL = cursorTool("CheckSubagent");
export const CREATE_AGENT_TOOL = cursorTool("CreateAgent");
export const CREATE_CHANNEL_TOOL = cursorTool("CreateChannel");
export const MESSAGE_SUBAGENT_TOOL = cursorTool("MessageSubagent");
export const STOP_SUBAGENT_TOOL = cursorTool("StopSubagent");
export const TASK_TOOL = cursorTool("Task");
export const TODO_WRITE_TOOL = cursorTool("TodoWrite");
export const UPDATE_AGENT_TOOL = cursorTool("UpdateAgent");
export const UPDATE_CHANNEL_TOOL = cursorTool("UpdateChannel");

export const UpdateStateInput = Schema.Struct({
  target: Schema.Literal(
    "memory",
    "routine",
    "skill",
    "profile",
    "settings",
    "channel",
    "project",
    "avatar"
  ),
  action: Schema.Literal(
    "write",
    "forget",
    "create",
    "update",
    "pause",
    "resume",
    "delete",
    "set",
    "disconnect",
    "join",
    "leave",
    "clear"
  ),
  fact: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000))),
  tier: Schema.optional(Schema.Literal("profile", "log", "note")),
  scope: Schema.optional(Schema.Literal("agent", "user", "project")),
  project: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))),
  id: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))),
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  prompt: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(50_000))),
  schedule: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500))),
  trigger: Schema.optional(Schema.Unknown),
  enabled: Schema.optional(Schema.Boolean),
  body: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100_000))),
  hidden_from_sidebar: Schema.optional(Schema.Boolean),
  notify_on_updates: Schema.optional(Schema.Boolean),
  dreaming_enabled: Schema.optional(Schema.Boolean),
  platform: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))),
  path: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000))),
});
export type UpdateStateInput = typeof UpdateStateInput.Type;

export const UPDATE_STATE_TOOL = nativeTool("update_state");

export const SCREENSHOT_TOOL = nativeTool("Screenshot");

export const COMPUTER_TOOL = {
  type: "function",
  name: "Computer",
  description:
    "Interact with your persistent OpenBot Linux graphical screen. Coordinates use the 1280x800 screenshot. Actions are move, click, type, key, scroll, open_app, and wait. Human takeover or emergency stop can temporarily reject input. A successful action returns a fresh screenshot.",
  inputSchema: {
    oneOf: [
      {
        type: "object",
        properties: {
          action: { const: "move" },
          x: { type: "integer", minimum: 0, maximum: 1279 },
          y: { type: "integer", minimum: 0, maximum: 799 },
        },
        required: ["action", "x", "y"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "click" },
          x: { type: "integer", minimum: 0, maximum: 1279 },
          y: { type: "integer", minimum: 0, maximum: 799 },
          button: { type: "string", enum: ["left", "middle", "right"] },
          double: { type: "boolean" },
        },
        required: ["action", "x", "y"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "type" },
          text: { type: "string", maxLength: 10000 },
        },
        required: ["action", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "key" },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { type: "string", pattern: "^[A-Za-z0-9_+-]+$" },
          },
        },
        required: ["action", "keys"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "scroll" },
          deltaY: { type: "integer", minimum: -20, maximum: 20 },
        },
        required: ["action", "deltaY"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "open_app" },
          app: { type: "string", enum: ["chromium", "thunar", "terminal"] },
        },
        required: ["action", "app"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "wait" },
          ms: { type: "integer", minimum: 0, maximum: 10000 },
        },
        required: ["action", "ms"],
        additionalProperties: false,
      },
    ],
  },
} as const;

const computerUseActionProperties = {
  action: {
    type: "string",
    enum: ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"],
  },
  x: { type: "integer", minimum: 0, maximum: 1279 },
  y: { type: "integer", minimum: 0, maximum: 799 },
  x2: { type: "integer", minimum: 0, maximum: 1279 },
  y2: { type: "integer", minimum: 0, maximum: 799 },
  path: {
    type: "array",
    minItems: 2,
    maxItems: 100,
    items: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, maximum: 1279 },
        y: { type: "integer", minimum: 0, maximum: 799 },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  text: { type: "string", maxLength: 10_000 },
  key: {
    type: "string",
    minLength: 1,
    maxLength: 80,
    pattern: "^[A-Za-z0-9_+\\-]+$",
  },
  button: { type: "string", enum: ["left", "right", "middle"] },
  count: { type: "integer", minimum: 1, maximum: 3 },
  modifiers: {
    type: "string",
    enum: ["shift", "ctrl", "alt", "meta", "ctrl+shift", "ctrl+alt", "meta+shift"],
  },
  direction: { type: "string", enum: ["up", "down", "left", "right"] },
  amount: { type: "integer", minimum: 1, maximum: 20 },
  durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
} as const;

export const COMPUTER_USE_TOOL = {
  type: "function",
  name: "Computer",
  description:
    "Control this worker's isolated 1280x800 desktop by screenshot, click, move, drag, type, key, scroll, and wait. Coordinates use pixels from the top-left. Every call returns one screenshot after all actions complete. Use then only for steps that need no intermediate visual verification.",
  inputSchema: {
    type: "object",
    properties: {
      ...computerUseActionProperties,
      then: {
        type: "array",
        minItems: 1,
        maxItems: 9,
        items: {
          type: "object",
          properties: computerUseActionProperties,
          required: ["action"],
          additionalProperties: false,
        },
      },
      description: { type: "string", maxLength: 500 },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

export const DynamicToolCallRequest = Schema.Struct({
  runId: Schema.String,
  botId: Schema.String,
  conversationId: Schema.String,
  channelId: Schema.String,
  deliveryId: Schema.NullOr(Schema.String),
  tool: Schema.String,
  arguments: Schema.Unknown,
  callId: Schema.String,
});
export type DynamicToolCallRequest = typeof DynamicToolCallRequest.Type;

export const ResolveApprovalInput = Schema.Struct({
  decision: ApprovalDecision,
});
export type ResolveApprovalInput = typeof ResolveApprovalInput.Type;

export const ComputerTurnRequest = Schema.Struct({
  runId: Schema.String,
  botId: Schema.String,
  contextSessionId: Schema.String,
  screenBotId: Schema.optional(Schema.String),
  conversationId: Schema.String,
  sessionPath: Schema.NullOr(Schema.String),
  content: Schema.String,
  clientMessageId: Schema.String,
  cwd: Schema.String,
  instructions: Schema.String,
  userInfo: Schema.optional(Schema.NullOr(Schema.String)),
  userInfoEpoch: Schema.optional(Schema.Number),
  todoUpdate: Schema.optional(Schema.NullOr(Schema.String)),
  automationTrigger: Schema.optional(Schema.NullOr(Schema.String)),
  resetSelfSummaryCount: Schema.optional(Schema.Boolean),
  channelId: Schema.String,
  deliveryId: Schema.NullOr(Schema.String),
  runtimeProfile: Schema.optional(Schema.Literal("agent", "subagent")),
  subagentType: Schema.optional(SubagentType),
  fileAttachments: Schema.optional(Schema.Array(Schema.String)),
  images: Schema.optional(Schema.Array(InlineImageInput).pipe(Schema.maxItems(8))),
  dynamicNamespaces: Schema.optional(Schema.Array(PluginDynamicNamespace)),
});
export type ComputerTurnRequest = typeof ComputerTurnRequest.Type;

export const ComputerSteerRequest = Schema.Struct({
  inboxId: Schema.String,
  clientMessageId: Schema.String,
  content: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200_000)),
  images: Schema.optional(Schema.Array(InlineImageInput).pipe(Schema.maxItems(8))),
});
export type ComputerSteerRequest = typeof ComputerSteerRequest.Type;

export const ComputerApprovalResolution = Schema.Struct({
  approvalId: Schema.String,
  decision: ApprovalDecision,
});
export type ComputerApprovalResolution = typeof ComputerApprovalResolution.Type;

export type ComputerEvent =
  | {
      type: "session.attached";
      provider: "pi";
      contextSessionId: string;
      sessionId: string;
      sessionPath: string;
      model: string;
    }
  | { type: "turn.started"; turnId: string }
  | {
      type: "input.delivered";
      turnId: string;
      inboxId: string;
      clientMessageId: string;
    }
  | { type: "item.started"; turnId: string; item: unknown }
  | { type: "agent.delta"; turnId: string; itemId: string; delta: string }
  | { type: "item.completed"; turnId: string; item: unknown }
  | {
      type: "approval.requested";
      approvalId: string;
      requestMethod: string;
      turnId: string;
      itemId: string;
      details: unknown;
    }
  | {
      type: "context.state";
      contextSessionId: string;
      epoch: number;
      archives: Array<{
        id: string;
        sequence: number;
        reason: string;
        prefixDigest: string;
        summaryDigest: string;
        tokensBefore: number | null;
        tokensAfter: number | null;
        imageCount: number;
        turnCount: number;
        startedAt: string;
        completedAt: string;
      }>;
    }
  | {
      type: "compaction";
      turnId: string;
      contextSessionId: string;
      compactionId: string;
      epoch: number;
      reason: string;
      prefixDigest: string;
      summaryDigest: string;
      tokensBefore: number | null;
      tokensAfter: number | null;
      imageCount: number;
      turnCount: number;
      startedAt: string;
      completedAt: string;
    }
  | {
      type: "runtime.error";
      turnId?: string;
      message: string;
      retrying: boolean;
    }
  | { type: "turn.completed"; turnId: string; status: string; error?: unknown };

export interface BotView {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  icon: string;
  color: string;
  hasAvatar: boolean;
  notificationsEnabled: boolean;
  hiddenFromSidebar: boolean;
  defaultDirectory: string;
  status: BotStatus;
  onboardingStatus: OnboardingStatus;
  onboardingVersion: number;
  onboardingCompletedAt: string | null;
  provisioningError: unknown | null;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  dmChannelId: string;
}

export interface TranscriptEventView {
  schemaVersion: 1;
  id: string;
  botId: string;
  at: string;
  type: "visible_message" | "run_started" | "run_completed" | "run_failed";
  channel: {
    id: string;
    kind: ChannelKind;
    name: string;
  } | null;
  sender: {
    kind: "user" | "agent" | "system";
    botId: string | null;
    name: string;
  } | null;
  content: string | null;
  metadata: Record<string, unknown>;
}

export interface BotTranscriptView {
  botId: string;
  generatedAt: string;
  events: TranscriptEventView[];
}

export interface ChannelMemberView {
  botId: string;
  ordinal: number;
}

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  name: string;
  directKey: string | null;
  workingDirectory: string | null;
  members: ChannelMemberView[];
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMessageView {
  id: string;
  sequence: string;
  channelId: string;
  sender: ChannelMessageSender;
  senderBotId: string | null;
  sourceRunId: string | null;
  content: string;
  metadata: unknown;
  createdAt: string;
}

export const SearchResultKind = Schema.Literal(
  "message",
  "bot",
  "channel",
  "file",
  "link",
  "routine"
);
export type SearchResultKind = typeof SearchResultKind.Type;

export const SearchCategory = Schema.Literal(
  "all",
  "messages",
  "bots",
  "channels",
  "files",
  "links",
  "routines"
);
export type SearchCategory = typeof SearchCategory.Type;

export interface SearchResultView {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  channelId: string | null;
  messageId: string | null;
  botId: string | null;
  url: string | null;
  createdAt: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResultView[];
}

export interface ChannelRoundView {
  id: string;
  channelId: string;
  triggerMessageId: string;
  rootMessageId: string;
  roundIndex: number;
  memberTurnOffset: number;
  initiatorBotId: string | null;
  status: string;
  currentOrdinal: number;
  createdAt: string;
  completedAt: string | null;
}

export interface MessageView {
  id: string;
  conversationId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunItemView {
  id: string;
  runId: string;
  kind: RunItemKind;
  status: string;
  title: string | null;
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RunView {
  id: string;
  botId: string;
  conversationId: string;
  status: RunStatus;
  runtimeTurnId: string | null;
  origin: RunOrigin;
  channelId: string | null;
  deliveryId: string | null;
  error: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalView {
  id: string;
  /** Runtime run that emitted the approval. For subagents this is the child run. */
  runId: string;
  runItemId: string | null;
  kind: string;
  status: string;
  details: unknown;
  createdAt: string;
  /** Parent conversation that owns and renders the approval. */
  ownerConversationId: string;
  /** Parent turn that launched the Task, or runId for a parent-owned approval. */
  parentRunId: string;
  /** Task invocation that owns a child approval. A resume has its own id. */
  parentToolCallId: string | null;
  /** Reusable child session for a child approval. */
  subagentId: string | null;
}

export interface SubagentActivityView {
  /** Immutable Task attempt id. This is runtime state, not a transcript entry. */
  id: string;
  /** Reusable child session id returned by Task. */
  subagentId: string;
  parentBotId: string;
  parentRunId: string;
  parentChannelId: string;
  parentToolCallId: string;
  currentRunId: string | null;
  description: string;
  subagentType: SubagentType;
  runInBackground: boolean;
  status: "provisioning" | "queued" | "running" | "completed" | "failed" | "stopped";
  /** Sanitized completion candidate. It is never inserted into chat automatically. */
  summary: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  cursor: string;
  workspace: {
    root: string;
    sharedDirectory: string;
    botsDirectory: string;
    projectsDirectory: string;
  };
  bots: BotView[];
  channels: ChannelView[];
  channelMessages: ChannelMessageView[];
  channelRounds: ChannelRoundView[];
  messages: MessageView[];
  runs: RunView[];
  runItems: RunItemView[];
  approvals: ApprovalView[];
  subagents: SubagentActivityView[];
  runtime: {
    server: "ready" | "degraded";
    database: "ready" | "unavailable";
    queue: "ready" | "unavailable";
    computer: "ready" | "unavailable";
    agent: "ready" | "missing" | "invalid" | "unavailable";
  };
}

/** Renderer projection. Internal transcript messages stay server-side. */
export type ClientSnapshot = Omit<Snapshot, "messages">;

export interface ProductEvent {
  sequence: string;
  topic: string;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}
