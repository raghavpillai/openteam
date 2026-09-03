import { existsSync } from "node:fs";
import { chown, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentToolResult,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  type ApprovalDecision,
  CALL_DYNAMIC_TOOL_TOOL,
  CallDynamicToolInput,
  CHECK_SUBAGENT_TOOL,
  CheckSubagentInput,
  COMPUTER_USE_TOOL,
  DEFAULT_PI_INFERENCE_MODEL,
  DEFAULT_PI_INFERENCE_PROVIDER,
  type ComputerEvent,
  type ComputerSteerRequest,
  type ComputerTurnRequest,
  ComputerUseInput,
  CREATE_AGENT_TOOL,
  CREATE_CHANNEL_TOOL,
  CreateAgentInput,
  CreateChannelInput,
  EXTERNAL_READ_TOOL,
  EXTERNAL_SHELL_TOOL,
  GET_DYNAMIC_TOOLS_TOOL,
  GetDynamicToolsInput,
  LIST_AGENTS_TOOL,
  LIST_GROUPS_TOOL,
  LIST_MACHINES_TOOL,
  ListAgentsInput,
  ListGroupsInput,
  MESSAGE_SUBAGENT_TOOL,
  MessageSubagentInput,
  NATIVE_TOOLS,
  formatPiModelRef,
  parsePiModelRef,
  piModelRef,
  type PiModelRef,
  type PluginDynamicNamespace,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  ReadToolInput,
  type RuntimeInlineImage,
  SCREENSHOT_TOOL,
  SEND_TO_USER_CLOSING_NUDGE_PROMPT,
  SEND_TO_USER_REPLY_NUDGE_PROMPT,
  SEND_TO_AGENT_TOOL,
  SEND_TO_USER_TOOL,
  SendToAgentInput,
  SHELL_TOOL,
  ShellToolInput,
  STOP_SUBAGENT_TOOL,
  StopSubagentInput,
  type SubagentType,
  TASK_TOOL,
  TaskInput,
  TODO_WRITE_TOOL,
  TodoWriteInput,
  UPDATE_AGENT_TOOL,
  UPDATE_CHANNEL_TOOL,
  UPDATE_STATE_TOOL,
  UpdateAgentInput,
  UpdateChannelInput,
} from "@openbot/contracts";
import { Schema } from "effect";
import { Type } from "typebox";
import { BROWSER_USE_TOOLS, BrowserUseSession } from "./browser-use";
import { agentProcessIdentity, sanitizedAgentEnvironment } from "./agent-process";
import { ComputerEventQueue } from "./computer-event-queue";
import {
  type DynamicNamespaceDefinition,
  type DynamicToolDefinition,
  discoverDynamicTools,
  resolveDynamicTool,
} from "./dynamic-tool-gateway";
import { assertGraphicalShellBoundary } from "./graphical-shell-policy";
import type { GrokAgentStore } from "./grok-agent-store";
import {
  countGrokImages,
  GROK_IMAGE_TRIGGER,
  GrokCompactionArchiveStore,
  GrokCompactionCoordinator,
  type GrokMessage,
  type GrokSummaryRequest,
  type GrokSummaryResult,
  grokPiPersistReserve,
  grokSummaryPrompt,
  grokSummarySystemPrompt,
  grokUserInfoMessage,
  replaceGrokUserInfo,
} from "./grok-compaction";
import {
  HostApprovalRequiredError,
  type HostApprovalTokens,
  NativeToolExecutor,
} from "./native-tool-executor";
import { ScreenBroker } from "./screen-broker";

const OPENBOT_DYNAMIC_DISCOVERY_DESCRIPTION =
  "Discover and inspect tools available through OpenBot dynamic namespaces. Search by namespace, exact tool name, or bounded regular-expression pattern. Catalog searches abbreviate long descriptions; exact lookups return complete public schemas. Always discover a tool before calling it with CallDynamicTool. The cursor namespace contains OpenBot's supported TodoWrite, bounded agent and group directory lookup, plugin lifecycle management, subagent orchestration, agent administration, and channel administration subset.";

const OPENBOT_DYNAMIC_CALL_DESCRIPTION =
  "Invoke one previously discovered tool from an authorized OpenBot dynamic namespace. The gateway rechecks availability, validates nested arguments against the current schema, and reauthorizes the call at execution time.";

const GRAPHICAL_WORKER_SHELL_DESCRIPTION =
  "Executes a command in this worker's box with an optional foreground timeout. Use Shell for terminal operations and bulk file processing; use Read for reading, searching, or inspecting files. Run independent commands in parallel and chain dependent commands with &&. If shell text search is necessary, use rg rather than grep or find.";

const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on. Text files include line numbers and support offset/limit paging. Image files are returned inline, and PDF files are converted to text.";

const HOST_ROUTING_DESCRIPTION =
  "By default this operates in the agent's isolated box. To target a user's connected computer, first call ListMachines and pass its exact machineId. Local-computer access is permission-gated and the requested command or file is shown to the user.";

export const REPLY_NUDGE_PROMPT = SEND_TO_USER_REPLY_NUDGE_PROMPT;

export const CLOSING_SEND_NUDGE_PROMPT = SEND_TO_USER_CLOSING_NUDGE_PROMPT;

export const isDeliveryOwed = (
  requestSource: NonNullable<ComputerTurnRequest["requestSource"]>
): boolean => ["turn", "handoff-resume", "broadcast", "connector"].includes(requestSource);

export const modelVisibleSummaryTools = (
  tools: ReadonlyArray<{
    name: string;
    description: string;
    parameters: unknown;
    constrainedSampling?: unknown;
  }>
) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  }));

const SUBAGENT_PRIVATE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  SEND_TO_USER_TOOL.name,
  REACT_TO_MESSAGE_TOOL.name,
  UPDATE_STATE_TOOL.name,
]);

const LEGACY_EXTERNAL_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  EXTERNAL_SHELL_TOOL.name,
  EXTERNAL_READ_TOOL.name,
]);

const PLUGIN_MANAGEMENT_TOOLS = [
  {
    name: "InstallPlugin",
    description: "Request user-confirmed installation of a marketplace plugin by pluginKey.",
    inputSchema: {
      type: "object",
      properties: {
        pluginKey: { type: "string", minLength: 1, maxLength: 160 },
        values: {
          type: "object",
          description: "Setup values returned by GetPlugin, keyed by setup field name.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["pluginKey"],
      additionalProperties: false,
    },
  },
  {
    name: "UninstallPlugin",
    description: "Request user-confirmed removal of a marketplace plugin and all of its accounts.",
    inputSchema: {
      type: "object",
      properties: {
        pluginKey: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["pluginKey"],
      additionalProperties: false,
    },
  },
  {
    name: "AddMcpServer",
    description:
      "Request a custom remote HTTP or local stdio MCP server. Provide exactly one of url or command.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 100 },
        url: { type: "string", maxLength: 2000 },
        command: { type: "string", maxLength: 500 },
        args: { type: "array", items: { type: "string" }, maxItems: 100 },
        env: { type: "object", additionalProperties: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: "string" } },
        auth: { type: "string", enum: ["none", "token", "oauth"] },
        accountLabel: { type: "string", maxLength: 80 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "UninstallMcpServer",
    description: "Request removal of a custom MCP server that was added outside the marketplace.",
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "AuthenticateMcpServer",
    description:
      "Request authentication for an installed MCP connection. Returns a browser authorization URL when confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        forceReauth: { type: "boolean" },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "RestartMcpServers",
    description: "Request a reconnect and fresh tool discovery for one MCP connection.",
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "RenameMcpAccount",
    description: "Request a new account label for an MCP connection.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        accountLabel: { type: "string", minLength: 2, maxLength: 80 },
      },
      required: ["connectionId", "accountLabel"],
      additionalProperties: false,
    },
  },
  {
    name: "RemoveMcpAccount",
    description: "Request removal of one named MCP account while keeping the plugin installed.",
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "SetMcpInstructions",
    description:
      "Request saved usage instructions for one MCP connection. An empty string clears them.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        instructions: { type: "string", maxLength: 500 },
      },
      required: ["connectionId", "instructions"],
      additionalProperties: false,
    },
  },
] as const;

type TurnStatus = "completed" | "failed" | "interrupted";

interface ActiveTurn {
  runId: string;
  botId: string;
  contextSessionId: string;
  screenBotId: string;
  conversationId: string;
  channelId: string;
  deliveryId: string | null;
  runtimeProfile: "agent" | "subagent";
  subagentType: SubagentType | null;
  modelRef: PiModelRef;
  cwd: string;
  instructions: string;
  userInfoMessage: GrokMessage | null;
  todoUpdate: string | null;
  automationTrigger: string | null;
  resetSelfSummaryCount: boolean;
  requestSource:
    | "turn"
    | "agent"
    | "automation"
    | "event"
    | "background-revival"
    | "handoff-resume"
    | "broadcast"
    | "connector"
    | "voice-call";
  turnId: string;
  session: AgentSession | null;
  sessionPath: string | null;
  sessionAttached: boolean;
  queue: ComputerEventQueue;
  unsubscribe: (() => void) | null;
  assistantOrdinal: number;
  currentAssistantId: string | null;
  currentReasoningId: string | null;
  startedItems: Set<string>;
  toolArgs: Map<string, { toolName: string; args: unknown }>;
  lastStopReason: string | null;
  lastErrorMessage: string | null;
  sentMessageCount: number;
  toolActivityAfterLastSend: boolean;
  initialUserStarted: boolean;
  pendingSteers: Array<{
    inboxId: string;
    clientMessageId: string;
    content: string;
  }>;
  acceptedSteerIds: Set<string>;
  discoveredDynamicTools: Set<string>;
  pluginNamespaces: readonly PluginDynamicNamespace[];
  attachmentTempDirectories: string[];
}

interface RuntimeDynamicTool extends DynamicToolDefinition {
  execute: (
    active: ActiveTurn,
    callId: string,
    args: unknown,
    signal?: AbortSignal
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

interface RuntimeImage {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const INLINE_IMAGE_PREFIX = /^data:(image\/(?:gif|jpeg|png|webp));base64,/i;

export const decodeInlineImages = (inputs: readonly RuntimeInlineImage[]): RuntimeImage[] =>
  inputs.slice(0, 8).map((input, index) => {
    const prefix = INLINE_IMAGE_PREFIX.exec(input.url);
    if (!prefix?.[1]) throw new Error(`Uploaded image ${index + 1} is not a supported data URL`);
    const encoded = input.url.slice(prefix[0].length);
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw new Error(`Uploaded image ${index + 1} has invalid base64 data`);
    }
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Uploaded image ${index + 1} exceeds 20 MB`);
    }
    return {
      type: "image",
      data: data.toString("base64"),
      mimeType: prefix[1].toLowerCase(),
    };
  });

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const VIDEO_EXTENSIONS = new Set([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

const attachmentPath = (cwd: string, value: string): string => {
  const path = resolve(isAbsolute(value) ? value : join(cwd, value));
  if (path !== "/workspace" && !path.startsWith("/workspace/")) {
    throw new Error(`Subagent attachment must be inside /workspace: ${value}`);
  }
  return path;
};

const textFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
};

const thinkingFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "thinking" &&
        typeof (part as { thinking?: unknown }).thinking === "string"
    )
    .map((part) => part.thinking)
    .join("");
};

const boundedText = (value: string, limit = 100_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n… output truncated by OpenBot`;

const safeToolResult = (result: unknown): unknown => {
  if (!result || typeof result !== "object") return result;
  const record = result as {
    content?: unknown;
    details?: unknown;
    isError?: unknown;
  };
  const content = Array.isArray(record.content)
    ? record.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const item = part as Record<string, unknown>;
        if (item.type === "image") {
          return {
            type: "image",
            mimeType: item.mimeType ?? "image/png",
            omitted: true,
          };
        }
        return item.type === "text" && typeof item.text === "string"
          ? { type: "text", text: boundedText(item.text) }
          : item;
      })
    : [];
  return {
    content,
    details: record.details ?? null,
    isError: Boolean(record.isError),
  };
};

const toolItem = (
  id: string,
  toolName: string,
  args: unknown,
  status: "inProgress" | "completed" | "failed",
  result?: unknown
): Record<string, unknown> => {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (["bash", "Shell", "ExternalShell"].includes(toolName)) {
    const toolResult =
      result && typeof result === "object" ? (result as Record<string, unknown>) : null;
    const details =
      toolResult?.details && typeof toolResult.details === "object"
        ? (toolResult.details as Record<string, unknown>)
        : null;
    return {
      type: "commandExecution",
      id,
      command: typeof record.command === "string" ? record.command : "Shell command",
      shellKind: details?.status === "running" ? "background" : "foreground",
      status,
      result,
    };
  }
  if (toolName === "edit" || toolName === "write") {
    return {
      type: "fileChange",
      id,
      tool: toolName,
      path: typeof record.path === "string" ? record.path : null,
      status,
      result,
    };
  }
  return {
    type: "dynamicToolCall",
    id,
    tool: toolName,
    arguments: args,
    status,
    result,
  };
};

export class ComputerRuntime {
  private readonly activeByRun = new Map<string, ActiveTurn>();
  private readonly activeByContext = new Map<string, ActiveTurn>();
  private readonly serverUrl = process.env.OPENBOT_SERVER_URL ?? "http://127.0.0.1:8787";
  private readonly controlToken =
    process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
  private readonly agentDir = resolve(process.env.OPENBOT_PI_AGENT_DIR ?? "/home/box/.pi/agent");
  private readonly sessionsDir = join(this.agentDir, "sessions", "openbot");
  private readonly contextSessionsDir = join(this.agentDir, "context-sessions");
  private readonly defaultModelRef = piModelRef(
    process.env.OPENBOT_PI_PROVIDER ?? DEFAULT_PI_INFERENCE_PROVIDER,
    process.env.OPENBOT_PI_MODEL ?? DEFAULT_PI_INFERENCE_MODEL
  );
  private readonly workspaceRoot = resolve(process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace");
  private readonly nativeToolExecutor = new NativeToolExecutor({
    agentDir: this.agentDir,
    controlToken: this.controlToken,
  });
  private readonly browserUseSessions = new Map<string, BrowserUseSession>();
  private readonly pendingApprovals = new Map<
    string,
    {
      runId: string;
      settle: (decision?: ApprovalDecision, error?: Error) => void;
    }
  >();
  private readonly thinkingLevel =
    (process.env.OPENBOT_PI_THINKING as
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | undefined) ?? "high";
  private modelRuntime: ModelRuntime | null = null;
  private readonly compactionArchive = new GrokCompactionArchiveStore(this.contextSessionsDir);
  private readonly compaction = new GrokCompactionCoordinator(this.compactionArchive);
  private authenticated = false;
  private authentication: { type: "api_key" | "oauth"; source?: string } | undefined;
  private started = false;

  constructor(
    private readonly screens = new ScreenBroker(),
    private readonly grokStore?: GrokAgentStore,
    private readonly onTurnEnd?: (dirty: {
      botId: string;
      screenBotId: string;
      cwd: string;
      sessionPath: string | null;
    }) => void
  ) {}

  async start(): Promise<void> {
    if (!this.started) {
      await mkdir(this.sessionsDir, { recursive: true });
      await mkdir(this.contextSessionsDir, { recursive: true });
      this.modelRuntime = await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
        modelsStorePath: join(this.agentDir, "models-store.json"),
        allowModelNetwork: false,
      });
      this.resolveModel(this.defaultModelRef);
      this.started = true;
    }
    await this.refreshAuthentication();
  }

  get diagnostics() {
    return {
      ready: this.started && this.modelRuntime !== null,
      runtimeEngine: "pi",
      inferenceProvider: this.defaultModelRef.providerId,
      model: this.defaultModelRef.modelId,
      qualifiedModel: formatPiModelRef(this.defaultModelRef),
      authenticated: this.authenticated,
      authType: this.authentication?.type ?? null,
      authSource: this.authentication?.source ?? null,
      subscription:
        this.authenticated &&
        Boolean(this.modelRuntime?.isUsingSubscription(this.defaultModelRef.providerId)),
      sessionScope: "transcript",
      activeTurns: this.activeByRun.size,
    };
  }

  async run(request: ComputerTurnRequest): Promise<AsyncIterable<ComputerEvent>> {
    await this.start();
    const modelRef = request.model
      ? parsePiModelRef(request.model, this.defaultModelRef.providerId)
      : this.defaultModelRef;
    if (this.activeByRun.has(request.runId)) {
      throw new Error(`Run ${request.runId} is already active`);
    }
    if (this.activeByContext.has(request.contextSessionId)) {
      throw new Error(`Context ${request.contextSessionId} already has an active Pi turn`);
    }

    const queue = new ComputerEventQueue();
    const active: ActiveTurn = {
      runId: request.runId,
      botId: request.botId,
      contextSessionId: request.contextSessionId,
      screenBotId: request.screenBotId ?? request.botId,
      conversationId: request.conversationId,
      channelId: request.channelId,
      deliveryId: request.deliveryId,
      runtimeProfile: request.runtimeProfile ?? "agent",
      subagentType: request.subagentType ?? null,
      modelRef,
      cwd: request.cwd,
      instructions: request.instructions,
      userInfoMessage: request.userInfo
        ? grokUserInfoMessage(request.userInfo, request.userInfoEpoch ?? 0)
        : null,
      todoUpdate: request.todoUpdate ?? null,
      automationTrigger: request.automationTrigger ?? null,
      resetSelfSummaryCount: request.resetSelfSummaryCount !== false,
      requestSource: request.requestSource ?? "turn",
      turnId: request.runId,
      session: null,
      sessionPath: null,
      sessionAttached: false,
      queue,
      unsubscribe: null,
      assistantOrdinal: 0,
      currentAssistantId: null,
      currentReasoningId: null,
      startedItems: new Set(),
      toolArgs: new Map(),
      lastStopReason: null,
      lastErrorMessage: null,
      sentMessageCount: 0,
      toolActivityAfterLastSend: false,
      initialUserStarted: false,
      pendingSteers: [],
      acceptedSteerIds: new Set(),
      discoveredDynamicTools: new Set(),
      pluginNamespaces: request.dynamicNamespaces ?? [],
      attachmentTempDirectories: [],
    };
    this.activeByRun.set(active.runId, active);
    this.activeByContext.set(active.contextSessionId, active);

    try {
      this.resolveModel(modelRef);
      const authentication = await this.modelRuntime?.checkAuth(modelRef.providerId);
      if (!authentication) {
        throw new Error(`Pi inference provider ${modelRef.providerId} is not configured`);
      }
      await this.grokStore?.openForWake(active.botId);
      await this.grokStore?.recordRequestId(active.botId, active.runId);
      await this.grokStore?.appendConversationEnvelope(active.botId, {
        role: "system",
        content: active.instructions,
        contextSessionId: active.contextSessionId,
        turnId: active.turnId,
      });
      if (request.agentProfileSnapshot) {
        await this.grokStore?.setPromptSnapshot(
          active.botId,
          "agentProfilePromptSnapshot",
          request.agentProfileSnapshot
        );
      }
      if (request.memorySnapshot) {
        await this.grokStore?.setPromptSnapshot(
          active.botId,
          "memoryPromptSnapshot",
          request.memorySnapshot
        );
      }
      await this.grokStore?.appendConversationEnvelope(active.botId, {
        role: "user",
        content: request.content,
        images: request.images?.length ?? 0,
        contextSessionId: active.contextSessionId,
        turnId: active.turnId,
      });
      // Reserve the run/context before the first asynchronous setup operation.
      // Otherwise two requests can both pass the checks above and open the same
      // append-only Pi session concurrently.
      const sessionPath = request.sessionPath ? this.assertSessionPath(request.sessionPath) : null;
      const contextState = await this.contextState(active.contextSessionId);
      await this.compactionArchive.enforceSizeLimit(active.contextSessionId, sessionPath);
      const uploadedImages = decodeInlineImages(request.images ?? []);
      const attachments = await this.loadAttachmentImages(
        request.cwd,
        request.fileAttachments ?? []
      );
      active.attachmentTempDirectories = attachments.tempDirectories;
      const session = await this.createSession({ ...request, sessionPath }, active);
      const openedSessionPath = session.sessionFile;
      if (!openedSessionPath) {
        session.dispose();
        throw new Error("Pi did not create a durable session file");
      }
      this.assertSessionPath(openedSessionPath);
      active.session = session;
      active.sessionPath = openedSessionPath;
      active.unsubscribe = session.subscribe((event) => this.routeEvent(active, event));
      await this.compactionArchive.enforceSizeLimit(active.contextSessionId, active.sessionPath);
      if (sessionPath) this.attachSession(active);
      queue.push(contextState);
      queue.push({ type: "turn.started", turnId: active.turnId });
      const images = [...uploadedImages, ...attachments.images].slice(0, 16);
      void this.execute(active, request.content, images);
      return queue;
    } catch (error) {
      this.cleanup(active);
      await Promise.allSettled(
        active.attachmentTempDirectories.map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
      );
      throw error;
    }
  }

  async contextState(
    contextSessionId: string
  ): Promise<Extract<ComputerEvent, { type: "context.state" }>> {
    await mkdir(this.contextSessionsDir, { recursive: true });
    await this.recoverStagedCompaction(contextSessionId);
    const manifest = await this.compactionArchive.manifest(contextSessionId);
    return {
      type: "context.state",
      contextSessionId,
      epoch: manifest.epoch,
      archives: manifest.archives.map((archive) => ({
        id: archive.id,
        sequence: archive.sequence,
        reason: archive.reason,
        prefixDigest: archive.prefixDigest,
        summaryDigest: archive.summaryDigest,
        tokensBefore: archive.tokensBefore,
        tokensAfter: archive.tokensAfter,
        imageCount: archive.imageCount,
        turnCount: archive.turnCount,
        startedAt: archive.startedAt,
        completedAt: archive.completedAt,
      })),
    };
  }

  private async recoverStagedCompaction(contextSessionId: string): Promise<void> {
    const stagedId = await this.compaction.stagedId(contextSessionId);
    if (!stagedId) return;
    if (!existsSync(this.sessionsDir)) {
      await this.compaction.recoverStaged(contextSessionId, 0, []);
      return;
    }
    const suffix = `_${contextSessionId}.jsonl`;
    const candidates = (await readdir(this.sessionsDir)).filter((name) => name.endsWith(suffix));
    if (candidates.length > 1) {
      throw new Error(`Multiple Pi sessions exist for context ${contextSessionId}`);
    }
    const candidate = candidates[0];
    if (!candidate) {
      await this.compaction.recoverStaged(contextSessionId, 0, []);
      return;
    }
    const sessionPath = this.assertSessionPath(join(this.sessionsDir, candidate));
    const manager = SessionManager.open(sessionPath, this.sessionsDir);
    const persistedCompactionIds = manager.getBranch().flatMap((entry) => {
      if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") {
        return [];
      }
      const details = entry.details as Record<string, unknown>;
      return details.openbotGrokCompaction === true && typeof details.id === "string"
        ? [details.id]
        : [];
    });
    await this.compaction.recoverStaged(
      contextSessionId,
      manager.buildSessionContext().messages.length,
      persistedCompactionIds
    );
  }

  private async loadAttachmentImages(
    cwd: string,
    fileAttachments: readonly string[]
  ): Promise<{ images: RuntimeImage[]; tempDirectories: string[] }> {
    const images: RuntimeImage[] = [];
    const tempDirectories: string[] = [];
    try {
      for (const value of fileAttachments.slice(0, 8)) {
        const path = attachmentPath(cwd, value);
        const details = await stat(path);
        if (!details.isFile()) throw new Error(`Subagent attachment is not a file: ${value}`);
        const extension = extname(path).toLowerCase();
        const imageMimeType = IMAGE_MIME_TYPES[extension];
        if (imageMimeType) {
          if (details.size > 20 * 1024 * 1024) {
            throw new Error(`Subagent image attachment exceeds 20 MB: ${value}`);
          }
          images.push({
            type: "image",
            data: Buffer.from(await readFile(path)).toString("base64"),
            mimeType: imageMimeType,
          });
          continue;
        }
        if (!VIDEO_EXTENSIONS.has(extension)) {
          throw new Error(`Unsupported subagent attachment type: ${value}`);
        }
        if (details.size > 500 * 1024 * 1024) {
          throw new Error(`Subagent video attachment exceeds 500 MB: ${value}`);
        }
        const directory = await mkdtemp(join(tmpdir(), "openbot-video-frames-"));
        tempDirectories.push(directory);
        const identity = agentProcessIdentity();
        if (identity.uid !== undefined && identity.gid !== undefined) {
          await chown(directory, identity.uid, identity.gid);
        }
        const child = Bun.spawn(
          [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path,
            "-vf",
            "select='eq(n,0)+gte(t-prev_selected_t,10)',scale='min(1280,iw)':-2",
            "-fps_mode",
            "vfr",
            "-frames:v",
            "12",
            "-pix_fmt",
            "yuvj420p",
            "-q:v",
            "3",
            join(directory, "%03d.jpg"),
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
            env: sanitizedAgentEnvironment(process.env),
            ...identity,
          }
        );
        const stderr = await new Response(child.stderr).text();
        if ((await child.exited) !== 0) {
          throw new Error(`Could not read subagent video attachment: ${stderr.slice(0, 500)}`);
        }
        const frames = (await readdir(directory))
          .filter((name) => name.endsWith(".jpg"))
          .sort()
          .slice(0, 12);
        if (frames.length === 0) throw new Error(`Video attachment produced no frames: ${value}`);
        for (const frame of frames) {
          images.push({
            type: "image",
            data: Buffer.from(await readFile(join(directory, frame))).toString("base64"),
            mimeType: "image/jpeg",
          });
        }
      }
      return { images: images.slice(0, 16), tempDirectories };
    } catch (error) {
      await Promise.all(
        tempDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
      );
      throw error;
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeByRun.get(runId);
    if (!active?.session) throw new Error("Run is not actively executing");
    await active.session.abort();
  }

  async deleteContextSession(contextSessionId: string, sessionPath?: string): Promise<void> {
    if (this.activeByContext.has(contextSessionId)) {
      throw new Error("Cannot delete an active context session");
    }
    await this.compaction.remove(contextSessionId);
    if (sessionPath) {
      await rm(this.assertSessionPath(sessionPath), { force: true });
    }
  }

  async steer(runId: string, request: ComputerSteerRequest): Promise<void> {
    const active = this.activeByRun.get(runId);
    if (!active?.session || !active.session.isStreaming) {
      throw new Error("Run is not actively processing a Pi turn");
    }
    if (active.acceptedSteerIds.has(request.inboxId)) return;
    const pending = {
      inboxId: request.inboxId,
      clientMessageId: request.clientMessageId,
      content: request.content,
    };
    active.acceptedSteerIds.add(request.inboxId);
    active.pendingSteers.push(pending);
    try {
      const images = decodeInlineImages(request.images ?? []);
      await active.session.prompt(request.content, {
        source: "rpc",
        streamingBehavior: "steer",
        ...(images.length ? { images } : {}),
      });
    } catch (error) {
      active.acceptedSteerIds.delete(request.inboxId);
      const index = active.pendingSteers.findIndex(
        (candidate) => candidate.inboxId === request.inboxId
      );
      if (index >= 0) active.pendingSteers.splice(index, 1);
      throw error;
    }
  }

  async infer(request: {
    instructions: string;
    prompt: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<string> {
    await this.start();
    if (!this.authenticated) {
      throw new Error(`Pi inference provider ${this.defaultModelRef.providerId} is not configured`);
    }
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    const model = this.resolveModel(this.defaultModelRef);
    const thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref();
    try {
      const result = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: request.instructions,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: request.prompt }],
              timestamp: Date.now(),
            },
          ] as never,
          tools: [],
        },
        {
          signal: controller.signal,
          reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        }
      );
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(result.errorMessage || `Memory inference ${result.stopReason}`);
      }
      const assistantText = textFromContent(result.content);
      if (!assistantText.trim()) throw new Error("Memory inference returned no assistant text");
      return assistantText;
    } catch (error) {
      if (timedOut) throw new Error("Memory inference timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error("This approval is no longer pending");
    pending.settle(decision);
  }

  private async refreshAuthentication(): Promise<void> {
    this.authentication = await this.modelRuntime?.checkAuth(this.defaultModelRef.providerId);
    this.authenticated = Boolean(this.authentication);
  }

  private resolveModel(ref: PiModelRef) {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    const model = modelRuntime.getModel(ref.providerId, ref.modelId);
    if (!model) throw new Error(`Pi does not provide ${formatPiModelRef(ref)}`);
    return model;
  }

  private async createSession(
    request: ComputerTurnRequest,
    active: ActiveTurn
  ): Promise<AgentSession> {
    const manager = request.sessionPath
      ? SessionManager.open(
          this.assertSessionPath(request.sessionPath),
          this.sessionsDir,
          request.cwd
        )
      : SessionManager.create(request.cwd, this.sessionsDir, {
          id: request.contextSessionId,
        });
    return this.createStandaloneSession(
      request.cwd,
      request.instructions,
      manager,
      active,
      active.modelRef
    );
  }

  private async createStandaloneSession(
    cwd: string,
    instructions: string,
    sessionManager: SessionManager,
    active?: ActiveTurn,
    modelRef: PiModelRef = this.defaultModelRef
  ): Promise<AgentSession> {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    const model = this.resolveModel(modelRef);
    const thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
    const persistReserve = grokPiPersistReserve(model.contextWindow ?? 0);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: modelRef.providerId,
      defaultModel: modelRef.modelId,
      defaultThinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
      compaction: {
        enabled: Boolean(active),
        reserveTokens: persistReserve,
        keepRecentTokens: 1,
      },
      retry: { enabled: true, maxRetries: 3 },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: instructions,
      ...(active
        ? {
            extensionFactories: [this.compactionExtension(sessionManager, active)],
          }
        : {}),
    });
    await resourceLoader.reload();
    const customTools = active ? this.customTools(active) : [];
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      thinkingLevel,
      noTools: "builtin",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return session;
  }

  private compactionExtension(
    sessionManager: SessionManager,
    active: ActiveTurn
  ): { name: string; hidden: boolean; factory: ExtensionFactory } {
    const infer = (request: GrokSummaryRequest, signal: AbortSignal) =>
      this.inferCompaction(active, request, signal);
    return {
      name: "openbot-grok-compaction",
      hidden: true,
      factory: (pi) => {
        pi.on("context", async (event) => {
          const usage = active.session?.getContextUsage();
          const messages = await this.compaction.modelContextMessages({
            contextSessionId: active.contextSessionId,
            piMessages: event.messages as GrokMessage[],
            systemPrompt: active.instructions,
            userInfoMessage: active.userInfoMessage,
            usedTokens: usage?.tokens ?? null,
            maxTokens: usage?.contextWindow ?? active.session?.model?.contextWindow ?? 0,
          });
          const adopted = this.compaction.takeProjectedEvent(active.contextSessionId);
          if (adopted) {
            active.queue.push({
              type: "compaction",
              turnId: active.turnId,
              contextSessionId: adopted.contextSessionId,
              compactionId: adopted.compactionId,
              epoch: adopted.epoch,
              reason: adopted.reason,
              prefixDigest: adopted.prefixDigest,
              summaryDigest: adopted.summaryDigest,
              tokensBefore: adopted.tokensBefore,
              tokensAfter: adopted.tokensAfter,
              imageCount: adopted.imageCount,
              turnCount: adopted.turnCount,
              startedAt: adopted.startedAt,
              completedAt: adopted.completedAt,
            });
          }
          return {
            messages: messages as typeof event.messages,
          };
        });
        pi.on("message_start", async (event) => {
          if (event.message.role !== "user" || !active.session) return;
          const usage = active.session.getContextUsage();
          await this.compaction.observe({
            contextSessionId: active.contextSessionId,
            piMessages: active.session.messages as GrokMessage[],
            systemPrompt: active.instructions,
            userInfoMessage: active.userInfoMessage,
            usedTokens: usage?.tokens ?? null,
            maxTokens: usage?.contextWindow ?? active.session.model?.contextWindow ?? 0,
            projectRoot: active.cwd,
            transcriptPath: active.sessionPath ?? undefined,
            todoUpdate: active.todoUpdate ?? undefined,
            automationTrigger: active.automationTrigger ?? undefined,
            infer,
          });
        });
        pi.on("session_before_compact", async (event) => {
          const prepared = await this.compaction.beforePiCompaction({
            contextSessionId: active.contextSessionId,
            piMessages: sessionManager.buildSessionContext().messages as GrokMessage[],
            reason: event.reason,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            systemPrompt: active.instructions,
            userInfoMessage: active.userInfoMessage,
            projectRoot: active.cwd,
            transcriptPath: active.sessionPath ?? undefined,
            todoUpdate: active.todoUpdate ?? undefined,
            automationTrigger: active.automationTrigger ?? undefined,
            infer,
            signal: event.signal,
          });
          return prepared ? { compaction: prepared as never } : { cancel: true };
        });
        pi.on("session_compact", async (event) => {
          const piMessages = sessionManager.buildSessionContext().messages as GrokMessage[];
          const retryError = event.willRetry ? piMessages.at(-1) : undefined;
          const piBaseMessageCount =
            retryError?.role === "assistant" &&
            ["error", "length"].includes(String(retryError.stopReason ?? ""))
              ? piMessages.length - 1
              : piMessages.length;
          const adopted = await this.compaction.afterPiCompaction({
            contextSessionId: active.contextSessionId,
            piBaseMessageCount,
          });
          if (!adopted) return;
          active.queue.push({
            type: "compaction",
            turnId: active.turnId,
            contextSessionId: adopted.contextSessionId,
            compactionId: adopted.compactionId,
            epoch: adopted.epoch,
            reason: adopted.reason,
            prefixDigest: adopted.prefixDigest,
            summaryDigest: adopted.summaryDigest,
            tokensBefore: adopted.tokensBefore,
            tokensAfter: adopted.tokensAfter,
            imageCount: adopted.imageCount,
            turnCount: adopted.turnCount,
            startedAt: adopted.startedAt,
            completedAt: adopted.completedAt,
          });
        });
        pi.on("session_compact_failed", async () => {
          await this.compaction.failCompaction(active.contextSessionId);
        });
      },
    };
  }

  private async inferCompaction(
    active: ActiveTurn,
    request: GrokSummaryRequest,
    signal: AbortSignal
  ): Promise<GrokSummaryResult> {
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
    const model = this.resolveModel(active.modelRef);
    const thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
    if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");

    // Grok's summarization wrapper sends the normal model-visible schemas through
    // a stream-only session. Calling the model runtime directly gives us the same
    // surface while making tool execution structurally impossible.
    const result = await modelRuntime.completeSimple(
      model,
      {
        systemPrompt: grokSummarySystemPrompt(request.systemPrompt),
        messages: [
          ...(request.userInfoMessage ? [request.userInfoMessage] : []),
          ...request.messagesToSummarize,
          {
            role: "user",
            content: [{ type: "text", text: grokSummaryPrompt(request.shorter) }],
            timestamp: Date.now(),
          },
        ] as never,
        tools: modelVisibleSummaryTools(this.customTools(active)) as never,
      },
      {
        signal,
        reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      }
    );
    if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
    // The coordinator owns Grok's special empty-output retry path.
    return {
      text: textFromContent(result.content),
      usage: result.usage as never,
    };
  }

  private customTools(active: ActiveTurn) {
    const native = (
      tool: (typeof NATIVE_TOOLS)[number],
      description: string = tool.description
    ) => {
      const visibleDescription =
        !active.subagentType && (tool.name === SHELL_TOOL.name || tool.name === READ_TOOL.name)
          ? `${HOST_ROUTING_DESCRIPTION}\n\n${description}`
          : description;
      return defineTool({
        name: tool.name,
        label: tool.name,
        description:
          tool.name === GET_DYNAMIC_TOOLS_TOOL.name
            ? OPENBOT_DYNAMIC_DISCOVERY_DESCRIPTION
            : tool.name === CALL_DYNAMIC_TOOL_TOOL.name
              ? OPENBOT_DYNAMIC_CALL_DESCRIPTION
              : visibleDescription,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        executionMode: "sequential" as const,
        execute: (callId: string, args: unknown, signal?: AbortSignal) =>
          this.executeOpenBotTool(active, callId, tool.name, args, signal),
      });
    };
    const workerNativeTools = NATIVE_TOOLS.filter(
      (tool) => tool.name === SHELL_TOOL.name || tool.name === READ_TOOL.name
    );
    const workerNative = (tool: (typeof NATIVE_TOOLS)[number]) =>
      native(
        tool,
        tool.name === SHELL_TOOL.name
          ? GRAPHICAL_WORKER_SHELL_DESCRIPTION
          : GRAPHICAL_WORKER_READ_DESCRIPTION
      );
    if (active.subagentType === "computerUse") {
      return [
        ...workerNativeTools.map(workerNative),
        defineTool({
          name: COMPUTER_USE_TOOL.name,
          label: COMPUTER_USE_TOOL.name,
          description: COMPUTER_USE_TOOL.description,
          parameters: Type.Unsafe<Record<string, unknown>>(COMPUTER_USE_TOOL.inputSchema),
          executionMode: "sequential",
          execute: (_callId, args) => this.callComputerUse(active, args),
        }),
      ];
    }
    if (active.subagentType === "browserUse") {
      return [
        ...workerNativeTools.map(workerNative),
        ...BROWSER_USE_TOOLS.map((tool) =>
          defineTool({
            name: tool.name,
            label: tool.name,
            description: tool.description,
            parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
            executionMode: "sequential",
            execute: (_callId, args) => this.callBrowserUse(active, tool.name, args),
          })
        ),
      ];
    }
    const availableNativeTools = NATIVE_TOOLS.filter(
      (tool) =>
        !LEGACY_EXTERNAL_NATIVE_TOOLS.has(tool.name) &&
        (!active.subagentType || !SUBAGENT_PRIVATE_NATIVE_TOOLS.has(tool.name))
    );
    return availableNativeTools.map((tool) => native(tool));
  }

  private async executeOpenBotTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (tool === SHELL_TOOL.name) {
      const shellInput = Schema.decodeUnknownSync(ShellToolInput)(args);
      assertGraphicalShellBoundary(shellInput.command, active.subagentType);
      if (shellInput.machineId) {
        if (active.subagentType) {
          throw new Error("Graphical subagents cannot target the user's local computer");
        }
        return this.executeHostTool(active, callId, tool, signal, (approvals) =>
          this.nativeToolExecutor.externalShell(shellInput, signal, approvals)
        );
      }
      const environment =
        active.subagentType === "computerUse"
          ? await this.screens.commandEnvironment(active.screenBotId, active.cwd)
          : undefined;
      return this.nativeToolExecutor.shell(shellInput, active.cwd, signal, environment);
    }
    if (tool === READ_TOOL.name) {
      const readInput = Schema.decodeUnknownSync(ReadToolInput)(args);
      if (readInput.machineId) {
        if (active.subagentType) {
          throw new Error("Graphical subagents cannot target the user's local computer");
        }
        return this.executeHostTool(active, callId, tool, signal, (approvals) =>
          this.nativeToolExecutor.externalRead(readInput, signal, approvals)
        );
      }
      return this.nativeToolExecutor.read(readInput, active.cwd);
    }
    if (tool === EXTERNAL_SHELL_TOOL.name) {
      const input = Schema.decodeUnknownSync(ShellToolInput)(args);
      return this.executeHostTool(active, callId, tool, signal, (approvals) =>
        this.nativeToolExecutor.externalShell(
          { ...input, machineId: input.machineId ?? "this-computer" },
          signal,
          approvals
        )
      );
    }
    if (tool === EXTERNAL_READ_TOOL.name) {
      const input = Schema.decodeUnknownSync(ReadToolInput)(args);
      return this.executeHostTool(active, callId, tool, signal, (approvals) =>
        this.nativeToolExecutor.externalRead(
          { ...input, machineId: input.machineId ?? "this-computer" },
          signal,
          approvals
        )
      );
    }
    if (tool === LIST_MACHINES_TOOL.name) {
      return this.nativeToolExecutor.listMachines(signal);
    }
    if (tool === SCREENSHOT_TOOL.name) {
      const frame = await this.screens.screenshot(active.botId, active.cwd);
      const directory = join(this.workspaceRoot, "shared", "screenshots");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${active.botId}-${Date.now()}.png`);
      await writeFile(path, frame, { mode: 0o644 });
      return {
        content: [
          {
            type: "text" as const,
            text: `Current OpenBot screen (1280x800). Saved to ${path}`,
          },
          {
            type: "image" as const,
            data: frame.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: { width: 1280, height: 800, path },
      };
    }
    if (tool === GET_DYNAMIC_TOOLS_TOOL.name) {
      return this.getDynamicTools(active, Schema.decodeUnknownSync(GetDynamicToolsInput)(args));
    }
    if (tool === CALL_DYNAMIC_TOOL_TOOL.name) {
      return this.callDynamicTool(
        active,
        callId,
        Schema.decodeUnknownSync(CallDynamicToolInput)(args),
        signal
      );
    }

    return this.callControlPlaneTool(active, callId, tool, args, signal);
  }

  private async executeHostTool(
    active: ActiveTurn,
    callId: string,
    toolName: string,
    signal: AbortSignal | undefined,
    execute: (approvals: HostApprovalTokens) => Promise<AgentToolResult<Record<string, unknown>>>
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const approvals: HostApprovalTokens = {};
    for (;;) {
      try {
        return await execute(approvals);
      } catch (error) {
        if (!(error instanceof HostApprovalRequiredError)) throw error;
        const decision = await this.requestHostApproval(active, callId, error, signal);
        if (decision === "accept") {
          if (error.approval.gate === "local") approvals.localApproval = "allow-once";
          else approvals.autoReviewApproval = "allow-once";
          continue;
        }
        if (decision === "always_allow") {
          if (error.approval.gate === "local") approvals.localApproval = "always";
          else approvals.autoReviewApproval = "always";
          continue;
        }
        if (decision === "never" && error.approval.gate === "local") {
          const machineId = error.approval.details.machineId;
          if (typeof machineId === "string") {
            await this.nativeToolExecutor.setLocalToolPermission(machineId, "never", signal);
          }
          throw new Error(
            "Local computer tools are disabled. Do not retry this action on the user's computer."
          );
        }
        if (error.approval.gate === "auto-review") {
          const reason =
            typeof error.approval.details.reason === "string"
              ? error.approval.details.reason
              : "The user denied the reviewed action";
          throw new Error(
            `Auto-review blocked this action: ${reason}. Do not retry the same action.`
          );
        }
        const action = toolName.toLowerCase().includes("shell") ? "Command" : "Action";
        throw new Error(
          `${action} failed to spawn: The user declined this action on their computer. Do not retry it. Do something else, use your own computer instead (Shell, Read), or ask them what they would prefer.`
        );
      }
    }
  }

  private requestHostApproval(
    active: ActiveTurn,
    callId: string,
    error: HostApprovalRequiredError,
    signal?: AbortSignal
  ): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.reject(new DOMException("Approval aborted", "AbortError"));
    const approvalId = crypto.randomUUID();
    return new Promise<ApprovalDecision>((resolveDecision, reject) => {
      const onAbort = () => settle(undefined, new DOMException("Approval aborted", "AbortError"));
      const settle = (decision?: ApprovalDecision, approvalError?: Error) => {
        if (!this.pendingApprovals.delete(approvalId)) return;
        signal?.removeEventListener("abort", onAbort);
        if (approvalError) reject(approvalError);
        else if (decision) resolveDecision(decision);
        else reject(new Error("Approval ended without a decision"));
      };
      this.pendingApprovals.set(approvalId, { runId: active.runId, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      active.queue.push({
        type: "approval.requested",
        approvalId,
        requestMethod: error.approval.requestMethod,
        turnId: active.turnId,
        itemId: callId,
        details: error.approval.details,
      });
    });
  }

  private async callComputerUse(
    active: ActiveTurn,
    args: unknown
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const input = Schema.decodeUnknownSync(ComputerUseInput)(args);
    const { then = [], description: _description, ...first } = input;
    const actions = [first, ...then];
    const frame = await this.screens.actComputerUse(active.screenBotId, active.cwd, actions);
    const directory = join(this.workspaceRoot, "shared", "screenshots");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${active.botId}-computer-${Date.now()}.png`);
    await writeFile(path, frame, { mode: 0o644 });
    return {
      content: [
        {
          type: "text" as const,
          text: `Computer completed ${actions.length} action${actions.length === 1 ? "" : "s"}. Final screenshot: ${path}`,
        },
        {
          type: "image" as const,
          data: frame.toString("base64"),
          mimeType: "image/png",
        },
      ],
      details: {
        actions: actions.map((action) => action.action),
        width: 1280,
        height: 800,
        path,
      },
    };
  }

  private async callBrowserUse(
    active: ActiveTurn,
    toolName: string,
    args: unknown
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const endpoint = await this.screens.browserEndpointForAgent(active.screenBotId, active.cwd);
    let browser = this.browserUseSessions.get(active.botId);
    if (!browser?.connected) {
      browser = await BrowserUseSession.connect(
        endpoint,
        join(this.workspaceRoot, "shared", "screenshots")
      );
      this.browserUseSessions.set(active.botId, browser);
    }
    return browser.execute(toolName, args);
  }

  private async callControlPlaneTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(tool === "Task" ? 24 * 60 * 60_000 : 30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId: active.runId,
        botId: active.botId,
        conversationId: active.conversationId,
        channelId: active.channelId,
        deliveryId: active.deliveryId,
        tool,
        arguments: args,
        callId,
      }),
      signal: requestSignal,
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `OpenBot tool host rejected the call (${response.status})`;
      throw new Error(message);
    }
    if (
      tool === SEND_TO_USER_TOOL.name &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).sent === true
    ) {
      active.sentMessageCount += 1;
      active.toolActivityAfterLastSend = false;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: typeof body === "string" ? body : JSON.stringify(body),
        },
      ],
      details: { tool },
    };
  }

  private executeReviewedTask(
    active: ActiveTurn,
    callId: string,
    args: TaskInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    return this.executeHostTool(active, callId, TASK_TOOL.name, signal, async (approvals) => {
      await this.nativeToolExecutor.autoReviewTask(args, signal, approvals);
      return this.callControlPlaneTool(active, callId, TASK_TOOL.name, args, signal);
    });
  }

  private async executeTodoWrite(
    active: ActiveTurn,
    callId: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const result = await this.callControlPlaneTool(
      active,
      callId,
      TODO_WRITE_TOOL.name,
      args,
      signal
    );
    const text = result.content.find((part) => part.type === "text")?.text;
    if (typeof text !== "string") return result;
    try {
      const body = JSON.parse(text) as { todos?: unknown };
      if (!Array.isArray(body.todos)) return result;
      const lines = body.todos.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const todo = candidate as Record<string, unknown>;
        if (
          typeof todo.id !== "string" ||
          typeof todo.content !== "string" ||
          typeof todo.status !== "string"
        ) {
          return [];
        }
        return [`- [${todo.status}] ${todo.id}: ${todo.content}`];
      });
      active.todoUpdate = lines.length > 0 ? lines.join("\n") : null;
    } catch {
      // Preserve the prior durable snapshot when a nonstandard tool host does
      // not return TodoWrite's documented JSON result.
    }
    return result;
  }

  private dynamicCatalog(
    active: ActiveTurn
  ): Array<DynamicNamespaceDefinition<RuntimeDynamicTool>> {
    const cursorTools: RuntimeDynamicTool[] = [
      {
        name: TODO_WRITE_TOOL.name,
        description: TODO_WRITE_TOOL.description,
        inputSchema: TODO_WRITE_TOOL.inputSchema,
        source: "first-party",
        decodeArguments: (args) => Schema.decodeUnknownSync(TodoWriteInput)(args),
        execute: (turn, callId, args, signal) => this.executeTodoWrite(turn, callId, args, signal),
      },
      ...(active.runtimeProfile === "subagent"
        ? []
        : [
            {
              name: LIST_AGENTS_TOOL.name,
              description: LIST_AGENTS_TOOL.description,
              inputSchema: LIST_AGENTS_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(ListAgentsInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, LIST_AGENTS_TOOL.name, args, signal),
            },
            {
              name: LIST_GROUPS_TOOL.name,
              description: LIST_GROUPS_TOOL.description,
              inputSchema: LIST_GROUPS_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(ListGroupsInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, LIST_GROUPS_TOOL.name, args, signal),
            },
            {
              name: SEND_TO_AGENT_TOOL.name,
              description: SEND_TO_AGENT_TOOL.description,
              inputSchema: SEND_TO_AGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(SendToAgentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, SEND_TO_AGENT_TOOL.name, args, signal),
            },
            {
              name: "SearchPlugins",
              description:
                "Search the bounded OpenBot plugin catalog. This is read-only; installation always requires the user to act in the Plugins UI.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string", maxLength: 200 } },
                required: ["query"],
                additionalProperties: false,
              },
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
                this.callControlPlaneTool(turn, callId, "SearchPlugins", args, signal),
            },
            {
              name: "GetPlugin",
              description:
                "Inspect one catalog or installed plugin, its components, and non-secret connection summary. Read-only.",
              inputSchema: {
                type: "object",
                properties: { pluginKey: { type: "string", maxLength: 200 } },
                required: ["pluginKey"],
                additionalProperties: false,
              },
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
                this.callControlPlaneTool(turn, callId, "GetPlugin", args, signal),
            },
            {
              name: "GetMcpServerStatus",
              description:
                "Read current MCP connection health, account aliases, tool counts, and bot-grant counts without exposing credentials.",
              inputSchema: {
                type: "object",
                properties: { connectionId: { type: "string" } },
                additionalProperties: false,
              },
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
                this.callControlPlaneTool(turn, callId, "GetMcpServerStatus", args, signal),
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
                this.callControlPlaneTool(turn, callId, tool.name, args, signal),
            })),
            {
              name: TASK_TOOL.name,
              description: TASK_TOOL.description,
              inputSchema: TASK_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(TaskInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.executeReviewedTask(
                  turn,
                  callId,
                  Schema.decodeUnknownSync(TaskInput)(args),
                  signal
                ),
            },
            {
              name: CHECK_SUBAGENT_TOOL.name,
              description: CHECK_SUBAGENT_TOOL.description,
              inputSchema: CHECK_SUBAGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) =>
                Schema.decodeUnknownSync(CheckSubagentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, CHECK_SUBAGENT_TOOL.name, args, signal),
            },
            {
              name: MESSAGE_SUBAGENT_TOOL.name,
              description: MESSAGE_SUBAGENT_TOOL.description,
              inputSchema: MESSAGE_SUBAGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) =>
                Schema.decodeUnknownSync(MessageSubagentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, MESSAGE_SUBAGENT_TOOL.name, args, signal),
            },
            {
              name: STOP_SUBAGENT_TOOL.name,
              description: STOP_SUBAGENT_TOOL.description,
              inputSchema: STOP_SUBAGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(StopSubagentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, STOP_SUBAGENT_TOOL.name, args, signal),
            },
            {
              name: CREATE_AGENT_TOOL.name,
              description: CREATE_AGENT_TOOL.description,
              inputSchema: CREATE_AGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(CreateAgentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, CREATE_AGENT_TOOL.name, args, signal),
            },
            {
              name: UPDATE_AGENT_TOOL.name,
              description: UPDATE_AGENT_TOOL.description,
              inputSchema: UPDATE_AGENT_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => Schema.decodeUnknownSync(UpdateAgentInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, UPDATE_AGENT_TOOL.name, args, signal),
            },
            {
              name: CREATE_CHANNEL_TOOL.name,
              description: CREATE_CHANNEL_TOOL.description,
              inputSchema: CREATE_CHANNEL_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) =>
                Schema.decodeUnknownSync(CreateChannelInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, CREATE_CHANNEL_TOOL.name, args, signal),
            },
            {
              name: UPDATE_CHANNEL_TOOL.name,
              description: UPDATE_CHANNEL_TOOL.description,
              inputSchema: UPDATE_CHANNEL_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) =>
                Schema.decodeUnknownSync(UpdateChannelInput)(args),
              execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
                this.callControlPlaneTool(turn, callId, UPDATE_CHANNEL_TOOL.name, args, signal),
            },
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
          execute: (turn: ActiveTurn, callId: string, args: unknown, signal?: AbortSignal) =>
            this.callControlPlaneTool(
              turn,
              callId,
              "PluginCall",
              {
                connectionId: tool.connectionId,
                toolName: tool.name,
                arguments: args,
              },
              signal
            ),
        })),
      }));
    return [
      {
        name: "cursor",
        description:
          "OpenBot's supported A2A messaging, TodoWrite, bounded agent and group directory lookup, read-only plugin management, subagent orchestration, agent administration, and channel administration tools.",
        kind: "first-party",
        namespaceStatus: "ready",
        tools: cursorTools,
      },
      ...pluginNamespaces,
    ];
  }

  private getDynamicTools(
    active: ActiveTurn,
    input: GetDynamicToolsInput
  ): AgentToolResult<Record<string, unknown>> {
    const result = discoverDynamicTools(
      this.dynamicCatalog(active),
      active.discoveredDynamicTools,
      input
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: { namespaceCount: result.namespaces.length },
    };
  }

  private async callDynamicTool(
    active: ActiveTurn,
    callId: string,
    input: CallDynamicToolInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const resolved = resolveDynamicTool(
      this.dynamicCatalog(active),
      active.discoveredDynamicTools,
      input
    );
    return resolved.tool.execute(active, callId, resolved.arguments, signal);
  }

  private async execute(
    active: ActiveTurn,
    content: string,
    images: RuntimeImage[]
  ): Promise<void> {
    let status: TurnStatus = "completed";
    let error: unknown;
    try {
      const session = active.session;
      if (!session) throw new Error("Pi session is not attached");
      await this.compaction.beginUserQuery(active.contextSessionId, active.resetSelfSummaryCount);
      await active.session?.prompt(content, { source: "rpc", images });
      if (isDeliveryOwed(active.requestSource)) {
        if (active.sentMessageCount === 0) {
          await session.prompt(REPLY_NUDGE_PROMPT, {
            source: "rpc",
            expandPromptTemplates: false,
          });
        } else if (active.toolActivityAfterLastSend) {
          await session.prompt(CLOSING_SEND_NUDGE_PROMPT, {
            source: "rpc",
            expandPromptTemplates: false,
          });
        }
      }
      const completedContext = replaceGrokUserInfo(
        await this.compaction.contextMessages(
          active.contextSessionId,
          session.messages as GrokMessage[]
        ),
        active.userInfoMessage
      );
      const imagePersist = countGrokImages(completedContext) >= GROK_IMAGE_TRIGGER;
      const projectedReason = this.compaction.projectedReason(active.contextSessionId);
      const projectedCommit = this.compaction.consumeProjectedCommit(active.contextSessionId);
      if (!projectedCommit && (imagePersist || projectedReason) && completedContext.length >= 3) {
        const forcedReason = imagePersist ? "approaching_image_limit" : projectedReason;
        if (!forcedReason) throw new Error("Missing forced compaction reason");
        this.compaction.forceReason(active.contextSessionId, forcedReason);
        try {
          await session.compact();
        } finally {
          this.compaction.clearForcedReason(active.contextSessionId);
        }
      }
      if (active.lastStopReason === "aborted") status = "interrupted";
      else if (active.lastStopReason === "error") {
        status = "failed";
        error = { message: active.lastErrorMessage ?? "Pi turn failed" };
      }
    } catch (caught) {
      status = "failed";
      error = {
        message: caught instanceof Error ? caught.message : String(caught),
      };
      active.queue.push({
        type: "runtime.error",
        turnId: active.turnId,
        message: (error as { message: string }).message,
        retrying: false,
      });
    } finally {
      this.compaction.discardBackground(active.contextSessionId);
      this.attachSession(active);
      if (this.grokStore) {
        await this.grokStore
          .recordTurnSettlement(active.botId, {
            turnId: active.turnId,
            status,
            ...(error === undefined ? {} : { error }),
          })
          .catch((settlementError) => console.warn("turn settlement persistence", settlementError));
      }
      active.queue.push({
        type: "turn.completed",
        turnId: active.turnId,
        status,
        error,
      });
      this.cleanup(active);
      await Promise.allSettled(
        active.attachmentTempDirectories.map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
      );
      this.onTurnEnd?.({
        botId: active.botId,
        screenBotId: active.screenBotId,
        cwd: active.cwd,
        sessionPath: active.sessionPath,
      });
      active.queue.end();
    }
  }

  private routeEvent(active: ActiveTurn, event: AgentSessionEvent): void {
    if (event.type === "message_start") {
      const message = event.message as { role?: string };
      if (message.role === "user") {
        if (!active.initialUserStarted) {
          active.initialUserStarted = true;
          return;
        }
        const steer = active.pendingSteers.shift();
        if (steer) {
          active.queue.push({
            type: "input.delivered",
            turnId: active.turnId,
            inboxId: steer.inboxId,
            clientMessageId: steer.clientMessageId,
          });
        }
        return;
      }
      if (message.role === "assistant") {
        active.assistantOrdinal += 1;
        active.currentAssistantId = `assistant:${active.runId}:${active.assistantOrdinal}`;
        active.currentReasoningId = `reasoning:${active.runId}:${active.assistantOrdinal}`;
      }
      return;
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && active.currentAssistantId) {
        this.startAgentMessage(active, active.currentAssistantId);
        active.queue.push({
          type: "agent.delta",
          turnId: active.turnId,
          itemId: active.currentAssistantId,
          delta: update.delta,
        });
      }
      return;
    }

    if (event.type === "message_end") {
      const message = event.message as {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
      if (message.role !== "assistant") return;
      active.lastStopReason = message.stopReason ?? null;
      active.lastErrorMessage = message.errorMessage ?? null;
      const text = textFromContent(message.content);
      void this.grokStore?.appendConversationEnvelope(active.botId, {
        role: "assistant",
        content: message.content,
        stopReason: message.stopReason ?? null,
        contextSessionId: active.contextSessionId,
        turnId: active.turnId,
      });
      if (text && active.currentAssistantId) {
        this.startAgentMessage(active, active.currentAssistantId);
        active.queue.push({
          type: "item.completed",
          turnId: active.turnId,
          item: {
            type: "agentMessage",
            id: active.currentAssistantId,
            text,
            status: "completed",
          },
        });
      }
      const thinking = thinkingFromContent(message.content);
      if (thinking && active.currentReasoningId) {
        this.startReasoning(active, active.currentReasoningId);
        active.queue.push({
          type: "item.completed",
          turnId: active.turnId,
          item: {
            type: "reasoning",
            id: active.currentReasoningId,
            text: thinking,
            status: "completed",
          },
        });
      }
      if (message.stopReason === "error" && message.errorMessage) {
        active.queue.push({
          type: "runtime.error",
          turnId: active.turnId,
          message: message.errorMessage,
          retrying: false,
        });
      }
      const usage = active.session?.getContextUsage();
      if (active.session && usage?.tokens !== null && usage) {
        void this.compaction
          .observe({
            contextSessionId: active.contextSessionId,
            piMessages: active.session.messages as GrokMessage[],
            systemPrompt: active.instructions,
            userInfoMessage: active.userInfoMessage,
            usedTokens: usage.tokens,
            maxTokens: usage.contextWindow,
            projectRoot: active.cwd,
            transcriptPath: active.sessionPath ?? undefined,
            infer: (prompt, signal) => this.inferCompaction(active, prompt, signal),
          })
          // Observation is best-effort and runs after the completed assistant
          // message. Persist-boundary compaction revalidates synchronously, so
          // a corrupt/missing archive will still fail closed before adoption.
          .catch(() => undefined);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      if (active.sentMessageCount > 0) {
        active.toolActivityAfterLastSend = true;
      }
      active.toolArgs.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
      });
      active.queue.push({
        type: "item.started",
        turnId: active.turnId,
        item: toolItem(event.toolCallId, event.toolName, event.args, "inProgress"),
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const stored = active.toolArgs.get(event.toolCallId);
      active.queue.push({
        type: "item.completed",
        turnId: active.turnId,
        item: toolItem(
          event.toolCallId,
          stored?.toolName ?? event.toolName,
          stored?.args ?? {},
          event.isError ? "failed" : "completed",
          safeToolResult(event.result)
        ),
      });
      active.toolArgs.delete(event.toolCallId);
      return;
    }

    if (event.type === "auto_retry_start") {
      active.queue.push({
        type: "runtime.error",
        turnId: active.turnId,
        message: event.errorMessage,
        retrying: true,
      });
    }
  }

  private startAgentMessage(active: ActiveTurn, itemId: string): void {
    if (active.startedItems.has(itemId)) return;
    active.startedItems.add(itemId);
    active.queue.push({
      type: "item.started",
      turnId: active.turnId,
      item: {
        type: "agentMessage",
        id: itemId,
        text: "",
        status: "inProgress",
      },
    });
  }

  private attachSession(active: ActiveTurn): void {
    if (
      active.sessionAttached ||
      !active.session ||
      !active.sessionPath ||
      !existsSync(active.sessionPath)
    ) {
      return;
    }
    active.sessionAttached = true;
    active.queue.push({
      type: "session.attached",
      runtimeEngine: "pi",
      inferenceProvider: active.modelRef.providerId,
      contextSessionId: active.contextSessionId,
      sessionId: active.session.sessionId,
      sessionPath: active.sessionPath,
      model: active.modelRef.modelId,
    });
  }

  private startReasoning(active: ActiveTurn, itemId: string): void {
    if (active.startedItems.has(itemId)) return;
    active.startedItems.add(itemId);
    active.queue.push({
      type: "item.started",
      turnId: active.turnId,
      item: { type: "reasoning", id: itemId, text: "", status: "inProgress" },
    });
  }

  private assertSessionPath(input: string): string {
    const candidate = resolve(input);
    const traversal = relative(this.sessionsDir, candidate);
    if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) {
      throw new Error("Pi session path is outside the OpenBot session directory");
    }
    if (!candidate.endsWith(".jsonl")) throw new Error("Pi session path must be a JSONL file");
    return candidate;
  }

  private cleanup(active: ActiveTurn): void {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.runId === active.runId) {
        pending.settle(undefined, new Error("The run ended before the approval was resolved"));
      }
    }
    this.activeByRun.delete(active.runId);
    this.activeByContext.delete(active.contextSessionId);
    active.unsubscribe?.();
    active.unsubscribe = null;
    active.session?.dispose();
    active.session = null;
  }
}
