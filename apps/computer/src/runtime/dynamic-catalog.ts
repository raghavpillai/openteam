import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  AWAIT_SHELL_TOOL,
  AwaitShellInput,
  CHECK_SUBAGENT_TOOL,
  CheckSubagentInput,
  CREATE_AGENT_TOOL,
  CREATE_CHANNEL_TOOL,
  CreateAgentInput,
  CreateChannelInput,
  LIST_AGENTS_TOOL,
  LIST_GROUPS_TOOL,
  ListAgentsInput,
  ListGroupsInput,
  MESSAGE_SUBAGENT_TOOL,
  MessageSubagentInput,
  REQUEST_BOX_HELP_TOOL,
  RequestBoxHelpInput,
  SEND_TO_AGENT_TOOL,
  SendToAgentInput,
  STOP_SUBAGENT_TOOL,
  StopSubagentInput,
  TASK_TOOL,
  TaskInput,
  TODO_WRITE_TOOL,
  TodoWriteInput,
  UPDATE_AGENT_TOOL,
  UPDATE_CHANNEL_TOOL,
  UpdateAgentInput,
  UpdateChannelInput,
} from "@openteam/contracts";
import { Schema } from "effect";
import { parseHostAwaitShellRequest } from "@openteam/contracts/service-protocol";
import type { DynamicNamespaceDefinition } from "../dynamic-tool-gateway";
import { objectToolSchema } from "../tool-schema";
import type { ActiveTurn, RuntimeDynamicTool, RuntimeDynamicToolCaller } from "./types";

export const PLUGIN_MANAGEMENT_TOOLS = [
  {
    name: "InstallPlugin",
    description: "Request user-confirmed installation of a marketplace plugin by pluginKey.",
    inputSchema: objectToolSchema(
      {
        pluginKey: { type: "string", minLength: 1, maxLength: 160 },
        values: {
          type: "object",
          description: "Setup values returned by GetPlugin, keyed by setup field name.",
          additionalProperties: { type: "string" },
        },
      },
      ["pluginKey"]
    ),
  },
  {
    name: "UninstallPlugin",
    description: "Request user-confirmed removal of a marketplace plugin and all of its accounts.",
    inputSchema: objectToolSchema(
      {
        pluginKey: { type: "string", minLength: 1, maxLength: 160 },
      },
      ["pluginKey"]
    ),
  },
  {
    name: "AddMcpServer",
    description:
      "Request a custom remote HTTP or local stdio MCP server. Provide exactly one of url or command.",
    inputSchema: objectToolSchema(
      {
        name: { type: "string", minLength: 2, maxLength: 100 },
        url: { type: "string", maxLength: 2000 },
        command: { type: "string", maxLength: 500 },
        args: { type: "array", items: { type: "string" }, maxItems: 100 },
        env: { type: "object", additionalProperties: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: "string" } },
        auth: { type: "string", enum: ["none", "token", "oauth"] },
        accountLabel: { type: "string", maxLength: 80 },
      },
      ["name"]
    ),
  },
  {
    name: "UninstallMcpServer",
    description: "Request removal of a custom MCP server that was added outside the marketplace.",
    inputSchema: objectToolSchema({ connectionId: { type: "string" } }, ["connectionId"]),
  },
  {
    name: "AuthenticateMcpServer",
    description:
      "Request authentication for an installed MCP connection. Returns a browser authorization URL when confirmed.",
    inputSchema: objectToolSchema(
      {
        connectionId: { type: "string" },
        forceReauth: { type: "boolean" },
      },
      ["connectionId"]
    ),
  },
  {
    name: "RestartMcpServers",
    description: "Request a reconnect and fresh tool discovery for one MCP connection.",
    inputSchema: objectToolSchema({ connectionId: { type: "string" } }, ["connectionId"]),
  },
  {
    name: "RenameMcpAccount",
    description: "Request a new account label for an MCP connection.",
    inputSchema: objectToolSchema(
      {
        connectionId: { type: "string" },
        accountLabel: { type: "string", minLength: 2, maxLength: 80 },
      },
      ["connectionId", "accountLabel"]
    ),
  },
  {
    name: "RemoveMcpAccount",
    description: "Request removal of one named MCP account while keeping the plugin installed.",
    inputSchema: objectToolSchema({ connectionId: { type: "string" } }, ["connectionId"]),
  },
  {
    name: "SetMcpInstructions",
    description:
      "Request saved usage instructions for one MCP connection. An empty string clears them.",
    inputSchema: objectToolSchema(
      {
        connectionId: { type: "string" },
        instructions: { type: "string", maxLength: 500 },
      },
      ["connectionId", "instructions"]
    ),
  },
] as const;

export function dynamicCatalog(
  callControlPlaneTool: RuntimeDynamicToolCaller,
  executeTodoWrite: RuntimeDynamicTool["execute"],
  executeReviewedTask: (
    active: ActiveTurn,
    callId: string,
    args: TaskInput,
    signal?: AbortSignal
  ) => Promise<AgentToolResult<Record<string, unknown>>>,
  active: ActiveTurn,
  executeAwaitShell: RuntimeDynamicTool["execute"],
  additionalTools: RuntimeDynamicTool[] = []
): Array<DynamicNamespaceDefinition<RuntimeDynamicTool>> {
  const controlPlaneTool = <A, I>(
    tool: { name: string; description: string; inputSchema: Readonly<Record<string, unknown>> },
    schema: Schema.Schema<A, I>
  ): RuntimeDynamicTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: "first-party",
    decodeArguments: (args) => Schema.decodeUnknownSync(schema)(args),
    execute: (turn, callId, args, signal) =>
      callControlPlaneTool(turn, callId, tool.name, args, signal),
  });
  const cursorTools: RuntimeDynamicTool[] = [
    ...additionalTools,
    {
      name: AWAIT_SHELL_TOOL.name,
      description: AWAIT_SHELL_TOOL.description,
      inputSchema: AWAIT_SHELL_TOOL.inputSchema,
      source: "first-party",
      decodeArguments: (args) => Schema.decodeUnknownSync(AwaitShellInput)(parseHostAwaitShellRequest(args)),
      execute: executeAwaitShell,
    },
    {
      name: TODO_WRITE_TOOL.name,
      description: TODO_WRITE_TOOL.description,
      inputSchema: TODO_WRITE_TOOL.inputSchema,
      source: "first-party",
      decodeArguments: (args) => Schema.decodeUnknownSync(TodoWriteInput)(args),
      execute: (turn, callId, args, signal) => executeTodoWrite(turn, callId, args, signal),
    },
    ...(active.runtimeProfile === "subagent"
      ? []
      : [
          controlPlaneTool(LIST_AGENTS_TOOL, ListAgentsInput),
          controlPlaneTool(LIST_GROUPS_TOOL, ListGroupsInput),
          controlPlaneTool(SEND_TO_AGENT_TOOL, SendToAgentInput),
          controlPlaneTool(REQUEST_BOX_HELP_TOOL, RequestBoxHelpInput),
          {
            name: "SearchPlugins",
            description:
              "Search the bounded OpenTeam plugin catalog. This is read-only; installation always requires the user to act in the Plugins UI.",
            inputSchema: objectToolSchema({ query: { type: "string", maxLength: 200 } }, ["query"]),
            source: "first-party" as const,
            decodeArguments: (args: unknown) => {
              const query =
                args && typeof args === "object"
                  ? (args as Record<string, unknown>).query
                  : undefined;
              if (typeof query !== "string") throw new Error("query is required");
              return { query: query.slice(0, 200) };
            },
            execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
              callControlPlaneTool(turn, callId, "SearchPlugins", args, signal),
          },
          {
            name: "GetPlugin",
            description:
              "Inspect one catalog or installed plugin, its components, and non-secret connection summary. Read-only.",
            inputSchema: objectToolSchema({ pluginKey: { type: "string", maxLength: 200 } }, [
              "pluginKey",
            ]),
            source: "first-party" as const,
            decodeArguments: (args: unknown) => {
              const pluginKey =
                args && typeof args === "object"
                  ? (args as Record<string, unknown>).pluginKey
                  : undefined;
              if (typeof pluginKey !== "string") throw new Error("pluginKey is required");
              return { pluginKey: pluginKey.slice(0, 200) };
            },
            execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
              callControlPlaneTool(turn, callId, "GetPlugin", args, signal),
          },
          {
            name: "GetMcpServerStatus",
            description:
              "Read current MCP connection health, account aliases, tool counts, and bot-grant counts without exposing credentials.",
            inputSchema: objectToolSchema({ connectionId: { type: "string" } }),
            source: "first-party" as const,
            decodeArguments: (args: unknown) => {
              const connectionId =
                args && typeof args === "object"
                  ? (args as Record<string, unknown>).connectionId
                  : undefined;
              if (connectionId !== undefined && typeof connectionId !== "string") {
                throw new Error("connectionId must be a string");
              }
              return connectionId ? { connectionId } : {};
            },
            execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
              callControlPlaneTool(turn, callId, "GetMcpServerStatus", args, signal),
          },
          ...PLUGIN_MANAGEMENT_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: "first-party" as const,
            decodeArguments: (args: unknown) => {
              if (!args || typeof args !== "object" || Array.isArray(args)) {
                throw new Error(`${tool.name} arguments must be an object`);
              }
              return args as Record<string, unknown>;
            },
            execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
              callControlPlaneTool(turn, callId, tool.name, args, signal),
          })),
          {
            name: TASK_TOOL.name,
            description: TASK_TOOL.description,
            inputSchema: TASK_TOOL.inputSchema,
            source: "first-party" as const,
            decodeArguments: (args: unknown) => Schema.decodeUnknownSync(TaskInput)(args),
            execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
              executeReviewedTask(turn, callId, Schema.decodeUnknownSync(TaskInput)(args), signal),
          },
          controlPlaneTool(CHECK_SUBAGENT_TOOL, CheckSubagentInput),
          controlPlaneTool(MESSAGE_SUBAGENT_TOOL, MessageSubagentInput),
          controlPlaneTool(STOP_SUBAGENT_TOOL, StopSubagentInput),
          controlPlaneTool(CREATE_AGENT_TOOL, CreateAgentInput),
          controlPlaneTool(UPDATE_AGENT_TOOL, UpdateAgentInput),
          controlPlaneTool(CREATE_CHANNEL_TOOL, CreateChannelInput),
          controlPlaneTool(UPDATE_CHANNEL_TOOL, UpdateChannelInput),
        ]),
  ];
  const pluginNamespaces: Array<DynamicNamespaceDefinition<RuntimeDynamicTool>> =
    active.pluginNamespaces.map((namespace) => ({
      name: namespace.name,
      description: namespace.description,
      kind: "mcp" as const,
      namespaceStatus: namespace.namespaceStatus,
      tools: namespace.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: tool.source,
        decodeArguments: (args: unknown) => args,
        execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal, mcpDetails?: unknown) =>
          callControlPlaneTool(
            turn,
            callId,
            "PluginCall",
            {
              connectionId: tool.connectionId,
              toolName: tool.name,
              arguments: args,
              mcpDetails,
            },
            signal
          ),
      })),
    }));
  return [
    {
      name: "cursor",
      description:
        "OpenTeam's supported A2A messaging, AwaitShell, TodoWrite, bounded agent and group directory lookup, plugin management, subagent orchestration, agent administration, and channel administration tools.",
      kind: "first-party",
      namespaceStatus: "ready",
      tools: cursorTools,
    },
    ...pluginNamespaces,
  ];
}
