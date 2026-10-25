import { applyArgumentAliases, normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { onlyPendingBackgroundWork } from "./background-status";
import { markDelivered } from "./events";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { agentReadStream, agentWriteStream } from "../agent-file-stream";
import { stageAttachment } from "../attachment-staging";
import { buildUserFormRemapReceipt } from "@openteam/contracts/reference-form-results";
import { renderDesktopResult, renderControlResult, sendToUserFailure, todoCleanupReminder, toolErrorDetail } from "@openteam/contracts/tool-results";
import { coerceArgumentsToJsonSchema, invalidArgumentsMessage } from "@openteam/contracts/tool-arguments";
import { normalizeMcpArgumentsToInputSchema } from "../mcp-argument-normalization";
import {
  describeUploadFileOutcome,
  describeDownloadFileOutcome,
  formatChromeCookieImportOutcome,
} from "@openteam/contracts/reference-formatters";
import { parseReferenceArguments } from "@openteam/contracts/reference-parsers";
import { parseDraftExternalMessage } from "@openteam/contracts/external-draft-body";
import { HostShellCompletions } from "../host-shell-completions";
import { expandPluginAgent } from "./plugin-components";
import { isReadonlyConnectorRead } from "./readonly-connectors";
import { computerArgumentsWithAliases } from "@openteam/contracts/computer-action-aliases";
import {
  CONNECTOR_TRANSFER_TOOLS,
  CONNECTOR_TRANSFER_MAX_BYTES,
  parseConnectorTransfer,
} from "@openteam/contracts/connector-transfers";
import { createHash } from "node:crypto";
import { DESKTOP_CAPABILITY_TOOLS } from "@openteam/contracts/desktop-capabilities";
import { agentFileIO } from "../agent-file-io";
import { connectorResultParts, spillConnectorText } from "./connector-results";
import { boundToolImage } from "./image-input";
import { redactSecrets } from "@openteam/shell-jobs";
import { validateProcessSecretName, WAKE_PARENT_TOOL } from "@openteam/contracts";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import {
  AwaitShellInput,
  AUTOMATION_PARENT_ONLY_TOOLS,
  AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED,
  CALL_DYNAMIC_TOOL_TOOL,
  CallDynamicToolInput,
  COMPUTER_USE_TOOL,
  CURSOR_TOOLS,
  parseUserForm,
  parseFormRemap,
  formatUserFormReceipt,
  ComputerUseInput,
  GET_DYNAMIC_TOOLS_TOOL,
  GetDynamicToolsInput,
  GRAPHICAL_SHELL_WAIT_CAP_MS,
  LIST_MACHINES_TOOL,
  NATIVE_TOOLS,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  ReadToolInput,
  REQUEST_BOX_HELP_TOOL,
  SCREENSHOT_TOOL,
  SEND_TO_USER_TOOL,
  SHELL_TOOL,
  SHELL_WAIT_CAP_MS,
  ShellToolInput,
  TASK_TOOL,
  type TaskInput,
  TODO_WRITE_TOOL,
  UPDATE_MEMORY_TOOL,
  UPDATE_ROUTINE_TOOL,
} from "@openteam/contracts";
import { Schema } from "effect";
import { parseHostAwaitShellRequest, type ShellAwaitResponse } from "@openteam/contracts/service-protocol";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, basename, resolve, dirname, sep } from "node:path";
import { Type } from "typebox";
import { BROWSER_USE_TOOLS, BrowserUseSession } from "../browser/use";
import {
  discoverDynamicTools,
  DynamicLookupMiss,
  renderDynamicDiscovery,
  type DynamicLookupOptions,
  type DynamicNamespaceDefinition,
  resolveDynamicTool,
  decodeDynamicArguments,
} from "../dynamic-tool-gateway";
import { assertGraphicalShellBoundary } from "../graphical-shell-policy";
import {
  NativeToolExecutor,
} from "../native-tool-executor";
import type { ScreenBroker } from "../screen-broker";
import { dynamicCatalog } from "./dynamic-catalog";
import { PRELOADED_TOOL_NAMES } from "./prompt-context";
import { firstPartyNamespaceDescription, taskToolContract } from "@openteam/contracts/tool-contracts";
import { subagentUsesParentConnectors, taskToolEnabled } from "@openteam/contracts/task-configuration";
import { WebTools } from "../web-tools";
import { SearchProviderClient } from "../search-provider";
import { FetchProviderClient } from "../fetch-provider";
import { serverSearchConfiguration, serverFetchConfiguration } from "../search-settings";
import { UserFormHost, type FormBrowser, type FormPageBinding } from "../user-form-host";
import { boxHelpPage } from "../box-help-page";
import { AutoReviewGate, withApprovalRetryParameters } from "./auto-review";
import type { ActiveTurn, RuntimeDynamicTool } from "./types";
import { renderShellAwaitResult } from "@openteam/shell-jobs";

export const GRAPHICAL_WORKER_SHELL_DESCRIPTION = [
  "Executes a given command in a shell session with optional foreground timeout.",
  "Use it for commands, scripts, installs, and creating or converting files. Read files with Read rather than `cat`, `head`, or `tail`, search file contents with `rg` rather than `grep` or `find`, and wait for a background command with AwaitShell rather than `sleep`. Before a destructive git step (force-pushing, skipping hooks with `--no-verify`, amending or rebasing commits that are already pushed, `reset --hard`), tell the user what it would overwrite and get their confirmation first, even when they asked for it.",
  "- Do not truncate output with `head`, `tail`, or `sed -n` solely to limit its size; large output is saved to a terminal file.\n- Run independent commands as parallel Shell calls. Chain dependent commands with `&&`.",
].join("\n\n");

export const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on.\n\nText files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.";

/** The reference's per-call guard: its 15-minute tier less a minute of headroom. */
export const TOOL_CALL_TIMEOUT_MS = 840_000;
/** Tools that wait on the user or a whole subagent run rather than on a service. */
const USER_PACED_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "Task",
  "InstallPlugin",
  "UninstallPlugin",
  "AddMcpServer",
  "UninstallMcpServer",
  "AuthenticateMcpServer",
  "RestartMcpServers",
  "RemoveMcpAccount",
  "RenameMcpAccount",
  "SetMcpInstructions",
]);
export const toolCallTimedOutMessage = (tool: string, timeoutMs: number) =>
  `The ${tool} tool call timed out after ${Math.round(timeoutMs / 1000)} seconds and was terminated. The execution environment may be unresponsive, or the operation needs longer than the per-call time limit.`;

/** A failed control-plane call, carrying the server's error code for callers that act on it. */
export class ControlPlaneError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number) {
    super(message);
  }
}
const INFRASTRUCTURE_FAILURE = /prisma|DriverAdapterError|database|deadlock detected|could not serialize access|terminating connection|Timed out fetching a new connection/i;
/** The server's message, never its JSON envelope; database failures and unreadable 5xx bodies read as the reference's retry-later sentence. */
const controlPlaneError = (status: number, body: unknown): ControlPlaneError => {
  const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const error = (typeof raw === "string" ? { message: raw } : raw) as { code?: unknown; message?: unknown } | undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" && error.message.trim() ? error.message : undefined;
  if (!message ? status >= 500 : status >= 500 && (!code || code === "internal_error") && INFRASTRUCTURE_FAILURE.test(message))
    return new ControlPlaneError("Couldn't finish due to a temporary server issue.", code, status);
  return new ControlPlaneError(message ?? `OpenTeam tool host rejected the call (${status})`, code, status);
};

const CONNECTOR_AUTH_FAILURES = new Set(["plugin_auth_required", "plugin_auth_failed"]);
/** Classified connector failures keep their message; anything else is the reference's "Tool execution error". */
const connectorCallError = (
  error: unknown,
  namespace: DynamicNamespaceDefinition,
  toolName: string,
  options: DynamicLookupOptions
): Error => {
  if (!(error instanceof ControlPlaneError)) return error instanceof Error ? error : new Error(String(error));
  if (CONNECTOR_AUTH_FAILURES.has(error.code ?? "")) {
    const guidance = options.unavailableGuidance?.({ ...namespace, namespaceStatus: "needsAuth" });
    return new Error(`${error.message}${guidance ? ` ${guidance}` : ""}`);
  }
  if (/MCP error -32(?:602|600|700)\b/.test(error.message))
    return new Error(`${error.message}\n\n<system_reminder>\nThe namespace rejected these arguments as invalid. Before retrying, call GetDynamicTools with ${JSON.stringify({ namespace: namespace.name, toolName })} and rebuild the arguments from the returned input schema.\n</system_reminder>`);
  if (!error.code || ["internal_error", "stdio_mcp_failed"].includes(error.code))
    return new Error(`Tool execution error. ${error.message}`);
  return error;
};

const AUTHENTICATE_GUIDANCE =
  "Call AuthenticateMcpServer on it instead of refetching this descriptor; it is already installed, so never propose installing it.";

/** GetDynamicTools and CallDynamicTool failures read `Error: <message>`, as the reference renders them;
 * a failed WebFetch keeps its own "Error fetching URL" text. */
const referenceError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  const plain = message.startsWith("Error: ") || (error instanceof Error && error.name === "WebFetchFailure");
  const wrapped = new Error(plain ? message : `Error: ${message}`, { cause: error });
  if (error instanceof Error) wrapped.name = error.name;
  throw wrapped;
};

/** How long a handoff waits for the box browser to show the step's page. */
const BOX_HELP_PAGE_TIMEOUT_MS = 12_000;
/** A question card waits on the user's answer, so it ends the turn after its response. */
const isQuestionSend = (args: unknown): boolean =>
  ["widget", "secret-request"].includes(String((args as { type?: unknown } | null)?.type));
export const EARLIER_SEND_FAILED_QUESTION_HELD =
  "Failed to send the message to the user: An earlier message in this response was not delivered (its own result says why), so this question was not shown either and the turn is still yours. Fix and resend that message, then ask again.";

/** Browser and desktop workers stay on the box, so their box tools take no machineId. */
const MACHINE_ROUTING_AWAIT_SENTENCE =
  "\n\nOmit machineId for a command started on your box. For a command started on one of the user's computers, pass the same machineId that was used for the Shell call.";
/** Shell and AwaitShell state the wait cap as "780000ms (13 minutes)" and "780000 (13 minutes)". */
const waitLimit = (capMs: number, unit: "ms" | "") => `${capMs}${unit} (${capMs / 60_000} minutes)`;
/** A computerUse worker may wait longer per Shell or AwaitShell call than any other agent. */
const shellWaitCapMs = (active: Pick<ActiveTurn, "subagentType">) =>
  active.subagentType === "computerUse" ? GRAPHICAL_SHELL_WAIT_CAP_MS : SHELL_WAIT_CAP_MS;
const assertShellWait = (active: Pick<ActiveTurn, "subagentType">, args: unknown, unit: "ms" | "") => {
  const capMs = shellWaitCapMs(active);
  const blockMs = (args as { block_until_ms?: unknown } | null)?.block_until_ms;
  if (typeof blockMs === "number" && blockMs > capMs)
    throw new Error(`${unit ? "" : "Invalid arguments:\nblock_until_ms: "}block_until_ms must be at most ${waitLimit(capMs, unit)}`);
};
const boxScopedSchema = (schema: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const { machineId: _machineId, ...properties } = (schema.properties ?? {}) as Record<string, unknown>;
  const wait = properties.block_until_ms as { description?: string } | undefined;
  if (wait)
    properties.block_until_ms = {
      ...wait,
      maximum: GRAPHICAL_SHELL_WAIT_CAP_MS,
      description: wait.description
        ?.replace(waitLimit(SHELL_WAIT_CAP_MS, "ms"), waitLimit(GRAPHICAL_SHELL_WAIT_CAP_MS, "ms"))
        .replace(waitLimit(SHELL_WAIT_CAP_MS, ""), waitLimit(GRAPHICAL_SHELL_WAIT_CAP_MS, "")),
    };
  return { ...schema, properties };
};

/** Computer's guidance when the browser tools sit beside it. */
const COMBINED_COMPUTER_GUIDANCE =
  " For anything inside a web page, use the browser_* tools first. Use Computer only for native UI (desktop apps, OS dialogs, browser chrome), a press-and-hold widget (click with holdDurationMs), or a step a browser tool has failed at for a technical reason, not to look at or wait on ordinary page state. After a click that did not land, re-target from the new screenshot before typing, and to replace a field's text, clear it first with key Control+a, then BackSpace.";

/** A readonly agent lists and greps with Shell, since Read opens one file and cannot list a directory. */
const READONLY_NATIVE_TOOLS = ["Read", "Shell", "RecallMemory", "GetDynamicTools", "CallDynamicTool", "ListSections"];

export const SUBAGENT_PRIVATE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "RecallMemory",
  "ListSections",
  SEND_TO_USER_TOOL.name,
  REACT_TO_MESSAGE_TOOL.name,
  UPDATE_MEMORY_TOOL.name,
  UPDATE_ROUTINE_TOOL.name,
  SCREENSHOT_TOOL.name,
]);

/** First-party tools a worker or routine run calls directly instead of looking them up with GetDynamicTools. */
export const workerTopLevelTools = (
  active: Pick<ActiveTurn, "subagentType" | "readOnly"> & Partial<Pick<ActiveTurn, "requestSource" | "runtimeProfile">>
): readonly string[] => {
  if (active.requestSource === "automation" && active.runtimeProfile !== "subagent") return [WAKE_PARENT_TOOL.name];
  // File transfers stay in the cursor namespace, as in the reference's Task worker manifest.
  if (active.subagentType === "executor" || active.subagentType === "knowledgeWork") return ["AwaitShell", "WebSearch", "WebFetch"];
  if (active.subagentType === "computerUse") return ["AwaitShell"];
  return [];
};

/** The reference's order for directly callable tools (its tool builders' order); others keep their place after these. */
const DIRECT_TOOL_ORDER = [
  WAKE_PARENT_TOOL.name, SEND_TO_USER_TOOL.name, REACT_TO_MESSAGE_TOOL.name, "ListSections", "RecallMemory",
  UPDATE_MEMORY_TOOL.name, UPDATE_ROUTINE_TOOL.name, "WebSearch", "WebFetch", SHELL_TOOL.name, READ_TOOL.name,
  "AwaitShell", SCREENSHOT_TOOL.name, GET_DYNAMIC_TOOLS_TOOL.name, CALL_DYNAMIC_TOOL_TOOL.name,
];
const directToolRank = (name: string) => {
  const rank = DIRECT_TOOL_ORDER.indexOf(name);
  return rank === -1 ? DIRECT_TOOL_ORDER.length : rank;
};

/** Calls that can create a file a Read in the same step is waiting for. */
const SAME_STEP_FILE_WRITERS: ReadonlySet<string> = new Set(["Shell", "AwaitShell", "CopyToBox"]);
const SAME_STEP_READ_WAIT_MS = 120_000;
/** A call cut off because a typed message superseded the run reads as interrupted by the user, as in the reference. */
const interruptibleByUser = <T extends { name: string; execute: (...args: any[]) => Promise<any> }>(active: ActiveTurn, tool: T): T => ({
  ...tool,
  execute: async (...args: any[]) => {
    const started = Date.now();
    try {
      return await tool.execute(...args);
    } catch (error) {
      const at = active.interruptedByUserAt;
      // Shell and AwaitShell already word their own interruption, as the reference does.
      if (at === undefined || /^Error: .* interrupted /.test(error instanceof Error ? error.message : "")) throw error;
      throw new Error(`Error: ${tool.name} was interrupted by the user after ${Math.max(0, at - started)}ms before it completed.`);
    }
  },
});

export class RuntimeTools {
  /** Auto-review: the safety check and approval cards for risky actions. */
  readonly autoReview = new AutoReviewGate((active, callId, tool, args, signal) => this.privateControl(active, callId, tool, args, signal));
  private readonly stepFileWriters = new Map<string, Set<Promise<unknown>>>();
  /** Box shells a stopped subagent left running in the background end with it. */
  stopBackgroundShells(botId: string) { return this.nativeToolExecutor.stopBackgroundShells(botId); }

  private async awaitShellForTurn(
    turn: ActiveTurn,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const started = Date.now();
    try {
      return await this.awaitShellOnce(turn, args, started, signal);
    } catch (error) {
      if (signal?.aborted) throw new Error(`Error: Await was interrupted by the user after ${Date.now() - started}ms.`);
      throw new Error(`Error awaiting task: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async awaitShellOnce(
    turn: ActiveTurn,
    args: unknown,
    started: number,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    assertShellWait(turn, args, "");
    const input = Schema.decodeUnknownSync(AwaitShellInput)(parseHostAwaitShellRequest(args));
    if (input.machineId && (turn.subagentType || turn.runtimeProfile === "subagent"))
      throw new Error("Subagents cannot target the user's local computer");
    const result = input.machineId
      ? await this.nativeToolExecutor.externalAwaitShell(input, signal)
      : await this.nativeToolExecutor.awaitShell(input, signal, turn.botId);
    if (
      input.machineId &&
      input.shell_id &&
      ["completed", "failed"].includes(String(result.details.status))
    )
      await this.hostShellCompletions.observe(turn.botId, input.machineId, input.shell_id);
    return result;
  }
  private readonly turnSecrets = new WeakMap<ActiveTurn, Record<string, string>>();

  private async processSecrets(
    active: ActiveTurn,
    signal?: AbortSignal
  ): Promise<Record<string, string>> {
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId: active.runId,
        botId: active.botId,
        conversationId: active.conversationId,
        channelId: active.channelId,
        deliveryId: active.deliveryId,
        callId: `${active.runId}:process-secrets`,
        tool: "ReadProcessSecrets",
        arguments: {},
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Process credential configuration could not be loaded");
    const result = (await response.json()) as { environment?: Record<string, unknown> };
    if (
      !result.environment ||
      typeof result.environment !== "object" ||
      Array.isArray(result.environment)
    )
      throw new Error("Invalid process credential configuration");
    const environment = Object.fromEntries(
      Object.entries(result.environment).map(([key, value]) => {
        if (typeof value !== "string") throw new Error("Invalid process credential configuration");
        return [validateProcessSecretName(key), value];
      })
    );
    this.turnSecrets.set(active, environment);
    return environment;
  }
  constructor(
    private readonly screens: ScreenBroker,
    private readonly serverUrl: string,
    private readonly controlToken: string,
    private readonly agentDir: string,
    private readonly workspaceRoot: string,
    private readonly canDeliverShellCompletion: (
      botId: string,
      channelId?: string
    ) => boolean = () => true
  ) {
    this.webTools = new WebTools(
      new SearchProviderClient(serverSearchConfiguration(serverUrl, controlToken)),
      new FetchProviderClient(serverFetchConfiguration(serverUrl, controlToken))
    );
    this.userForms = new UserFormHost(join(agentDir, "private-user-forms"), (botId) =>
      this.formBrowser(botId)
    );
    const deliverShellCompletion = async (
      completion: import("@openteam/contracts").ShellCompletionInput
    ) => {
      if (!completion.scope) return;
      if (!this.canDeliverShellCompletion(completion.scope, completion.channelId))
        throw new Error("Defer shell notification until the current turn ends");
      const response = await fetch(`${this.serverUrl}/api/v0/internal/shell-completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(completion),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Shell completion delivery failed (${response.status})`);
    };
    this.nativeToolExecutor = new NativeToolExecutor({
      agentDir,
      controlToken,
      serverUrl: this.serverUrl,
      onShellComplete: deliverShellCompletion,
    });
    this.hostShellCompletions = new HostShellCompletions(
      join(agentDir, "private-host-shells"),
      async (job) => {
        const result = await this.nativeToolExecutor.externalAwaitShell({
          machineId: job.machineId,
          shell_id: job.shellId,
          block_until_ms: 0,
        });
        return result.details as unknown as import("@openteam/contracts/service-protocol").ShellAwaitResponse;
      },
      deliverShellCompletion
    );
  }
  private readonly hostShellCompletions: HostShellCompletions;
  private readonly nativeToolExecutor: NativeToolExecutor;
  private readonly webTools: WebTools;
  readonly userForms: UserFormHost;
  private readonly mutationTails = new Map<string, Promise<unknown>>();
  private readonly toolCallTimeoutMs = TOOL_CALL_TIMEOUT_MS;
  private readonly browserSessionScreens = new Map<string, string>();

  async recoverFormOutcomes(active: ActiveTurn) {
    if (active.subagentType || !active.session) return;
    for (const receipt of await this.userForms.pendingRemaps(active.botId)) {
      const recorded = await this.callControlPlaneTool(
        active,
        `form-recovery:${receipt.formId}`,
        "RecordUserFormRemap",
        receipt
      );
      const resultText = recorded.content.find((part) => part.type === "text");
      const cardOutcome = resultText?.type === "text" ? JSON.parse(resultText.text) : undefined;
      const key = `form-recovery:${receipt.formId}:${JSON.stringify(receipt)}`;
      if (
        !active.session.messages.some(
          (message) =>
            message.role === "custom" &&
            (message.details as { messageId?: string })?.messageId === key
        )
      )
        await active.session.sendCustomMessage(
          {
            customType: "openteam-card-outcome",
            content: formatUserFormReceipt(receipt),
            display: false,
            details: { messageId: key, origin: "host", cardOutcome },
          },
          { triggerTurn: false }
        );
      await this.userForms.acknowledgeRemap(active.botId, receipt.formId);
    }
  }

  async acknowledgeToolOutcomes(
    active: ActiveTurn,
    messages: readonly import("../bot-compaction").BotMessage[]
  ) {
    const receipts = messages
      .flatMap((message) => {
        const item = message as {
          role: string;
          details?: { cardOutcome?: { messageId: string; outcomeId: string } };
        };
        return ["toolResult", "custom"].includes(item.role) && item.details?.cardOutcome
          ? [item.details.cardOutcome]
          : [];
      })
      .filter((receipt) => !active.acknowledgedCardOutcomes?.has(receipt.outcomeId));
    if (!receipts.length) return;
    try {
      await this.callControlPlaneTool(
        active,
        `${active.runId}:card-outcomes`,
        "AcknowledgeCardOutcomes",
        { receipts }
      );
    } catch {
      return;
    }
    active.acknowledgedCardOutcomes ??= new Set();
    for (const receipt of receipts) active.acknowledgedCardOutcomes.add(receipt.outcomeId);
  }

  contextCatalog(active: ActiveTurn) {
    return this.dynamicCatalog(active).map((namespace) => ({
      name: namespace.name,
      description: namespace.description,
      namespaceStatus: namespace.namespaceStatus,
      tools: namespace.tools.map(({ name, description, inputSchema }) =>
        namespace.name === "cursor" && PRELOADED_TOOL_NAMES.has(name) ? { name, description, inputSchema } : { name }
      ),
    }));
  }

  private readonly privateBrowserValues = new Map<string, Set<string>>();
  private readonly browserUseSessions = new Map<string, BrowserUseSession>();
  private readonly browserConnects = new Map<string, Promise<BrowserUseSession>>();

  customTools(active: ActiveTurn) {
    this.prewarmBrowser(active);
    return this.definedTools(active).map((tool) => interruptibleByUser(active, tool));
  }

  private definedTools(active: ActiveTurn) {
    if (active.subagentType === "videoReview" || active.subagentType === "watchVideo") return [];
    const native = (
      tool: (typeof NATIVE_TOOLS)[number],
      description: string = tool.description
    ) => {
      if (tool.name === "Task") {
        tool = { ...tool, ...taskToolContract(active.taskConfiguration) };
        description = tool.description;
      }
      // Workers and routine runs cannot start a sign-in; they report a signed-out connector instead.
      if (tool.name === GET_DYNAMIC_TOOLS_TOOL.name && !this.cursorToolNames(active).includes("AuthenticateMcpServer"))
        description = description.replace(
          AUTHENTICATE_GUIDANCE,
          `You cannot do that from here, so report the status ${active.requestSource === "automation" ? "with WakeParent" : "in your result"} instead of retrying.`
        );
      const visibleDescription = description;
      // Auto-review adds the approval-retry parameters while it is on, as the reference does in enforce mode.
      if (this.autoReview.enabled(active)) tool = withApprovalRetryParameters(tool);
      return defineTool({
        name: tool.name,
        label: tool.name,
        description: visibleDescription,
        parameters: Type.Unsafe<Record<string, unknown>>(
          tool.name === "Task" && active.pluginRuntimePackages?.some((pkg) => pkg.agents.length)
            ? {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema as any).properties,
                  plugin_agent: {
                    type: "string",
                    description: "Installed plugin agent template, plugin:agent",
                  },
                },
              }
            : tool.inputSchema
        ),
        // Every call starts as soon as the response ends, as in the reference; sends keep call order (below).
        executionMode: "parallel",
        execute: (callId: string, args: unknown, signal?: AbortSignal) =>
          this.executeOpenTeamTool(active, callId, tool.name, args, signal),
      });
    };
    const workerNativeTools = NATIVE_TOOLS.filter(
      (tool) => tool.name === SHELL_TOOL.name || tool.name === READ_TOOL.name
    );
    const workerNative = (tool: (typeof NATIVE_TOOLS)[number]) =>
      native(
        { ...tool, inputSchema: boxScopedSchema(tool.inputSchema) } as (typeof NATIVE_TOOLS)[number],
        tool.name === SHELL_TOOL.name
          ? GRAPHICAL_WORKER_SHELL_DESCRIPTION
          : GRAPHICAL_WORKER_READ_DESCRIPTION
      );
    const graphical = active.subagentType === "computerUse";
    const computerTool = () => defineTool({
          name: COMPUTER_USE_TOOL.name,
          label: COMPUTER_USE_TOOL.name,
          description: COMPUTER_USE_TOOL.description.replace(
            "scroll, and wait.",
            `scroll, and wait.${COMBINED_COMPUTER_GUIDANCE}`
          ),
          parameters: Type.Unsafe<Record<string, unknown>>(COMPUTER_USE_TOOL.inputSchema),
          // Aliased actions must be rewritten before the schema check refuses them.
          prepareArguments: (args: unknown) => computerArgumentsWithAliases(args) as Record<string, unknown>,
          executionMode: "sequential",
          execute: (callId, args, signal) =>
            this.executeGraphicalAction(active, signal, () =>
              this.callComputerUse(active, args, signal, callId)
            ),
        });
    // UploadFile and DownloadFile exist only while a connection can take or give files.
    const topLevelTools = () => {
      const firstParty = this.fullDynamicCatalog(active).find((namespace) => namespace.name === "cursor")?.tools ?? [];
      return workerTopLevelTools(active).flatMap((name) => {
      const tool = firstParty.find((candidate) => candidate.name === name);
      if (!tool) return [];
      return [defineTool({
        name,
        label: name,
        description: graphical ? tool.description.replace(MACHINE_ROUTING_AWAIT_SENTENCE, "") : tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(graphical ? boxScopedSchema(tool.inputSchema) : tool.inputSchema),
        // WakeParent ends the run, so nothing runs beside it.
        executionMode: name === WAKE_PARENT_TOOL.name ? "sequential" : "parallel",
        execute: (callId: string, args: unknown, signal?: AbortSignal) =>
          this.executeOpenTeamTool(active, callId, name, args, signal),
      })];
      });
    };
    const browserTools = () => BROWSER_USE_TOOLS.map((tool) =>
          defineTool({
            name: tool.name,
            label: tool.name,
            description: tool.description,
            parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
            executionMode: "sequential",
            execute: (callId, args, signal) =>
              this.executeGraphicalAction(active, signal, () =>
                this.callBrowserUse(active, tool.name, args, signal, callId)
              ),
          })
        );
    if (graphical) {
      return [
        ...workerNativeTools.map(workerNative),
        ...topLevelTools(),
        computerTool(),
        ...browserTools(),
      ].filter(tool => taskToolEnabled(active.taskConfiguration, tool.name) &&
        // AwaitShell only waits on Shell's background commands.
        (tool.name !== "AwaitShell" || taskToolEnabled(active.taskConfiguration, SHELL_TOOL.name)));
    }
    const availableNativeTools = NATIVE_TOOLS.filter(
      (tool) =>
        (!active.readOnly || READONLY_NATIVE_TOOLS.includes(tool.name)) &&
        (active.requestSource !== "automation" || !AUTOMATION_PARENT_ONLY_TOOLS.has(tool.name)) &&
        (!active.subagentType || !SUBAGENT_PRIVATE_NATIVE_TOOLS.has(tool.name))
    );
    return [
      ...availableNativeTools.map((tool) => native(tool)),
      ...topLevelTools(),
    ].sort((a, b) => directToolRank(a.name) - directToolRank(b.name));
  }

  private async executeOpenTeamTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const name = tool === CALL_DYNAMIC_TOOL_TOOL.name ? (args as { toolName?: unknown } | null)?.toolName : tool;
    // Pi starts a parallel batch in call order, so chaining sends here delivers them in call order.
    const run = tool === SEND_TO_USER_TOOL.name
      ? (active.sendChain ?? Promise.resolve()).then(() => this.executeScopedTool(active, callId, tool, args, signal))
      : this.executeScopedTool(active, callId, tool, args, signal);
    if (tool === SEND_TO_USER_TOOL.name) active.sendChain = run.catch(() => undefined);
    // Calls issued in one step start in order, so a later Read in the step can wait for these.
    const writers = typeof name === "string" && SAME_STEP_FILE_WRITERS.has(name)
      ? this.stepFileWriters.get(active.runId) ?? new Set<Promise<unknown>>()
      : undefined;
    if (writers) {
      writers.add(run);
      this.stepFileWriters.set(active.runId, writers);
    }
    try {
      return await run;
    } catch (error) {
      if (tool === SEND_TO_USER_TOOL.name) active.failedResponseSends?.add(callId);
      if (signal?.aborted) throw error;
      const report = invalidArgumentsMessage(error);
      // Every SendToUser failure reads as one sentence saying the send failed and why.
      if (tool === SEND_TO_USER_TOOL.name)
        throw new Error(sendToUserFailure(report ?? toolErrorDetail(error)));
      throw report ? new Error(report) : error;
    } finally {
      if (writers) {
        writers.delete(run);
        if (!writers.size) this.stepFileWriters.delete(active.runId);
      }
    }
  }

  private async executeScopedTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (tool === "Task")
      args = expandPluginAgent(active.pluginRuntimePackages ?? [], args as Record<string, unknown>);
    if (
      active.readOnly &&
      !READONLY_NATIVE_TOOLS.includes(tool) &&
      !workerTopLevelTools(active).includes(tool)
    )
      throw new Error("This plugin agent is read-only");
    if (active.readOnly && ["Read", "Shell", "AwaitShell"].includes(tool) && (args as Record<string, unknown>).machineId)
      throw new Error("Read-only agents cannot access the user's computer");
    signal?.throwIfAborted();
    active.pluginAbortController?.signal.throwIfAborted();
    // Pi validates arguments before execution, so the raw-argument match recorded
    // when the call started is authoritative; the direct comparison covers the rest.
    const responseCall = active.pendingResponseCalls?.has(callId) === true &&
      (active.toolArgs?.get(callId)?.responseCall === true ||
        active.pendingResponseCalls?.get(callId) === JSON.stringify(args));
    const afterEndTurn = active.endTurnRequested === true && active.finishResponseCalls === true && responseCall;
    if (active.endTurnRequested && !afterEndTurn)
      throw new Error("The turn has ended after delivery; wait for the next user message.");
    // Consume once, even on failure. This is not a retry or a new action grant.
    if (responseCall) active.pendingResponseCalls?.delete(callId);
    if (tool === SEND_TO_USER_TOOL.name && isQuestionSend(args) && active.failedResponseSends?.size)
      throw new Error(EARLIER_SEND_FAILED_QUESTION_HELD);
    if (active.requestSource === "automation" && AUTOMATION_PARENT_ONLY_TOOLS.has(tool)) {
      throw new Error(AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED);
    }
    args = normalizeMainToolArguments(tool, args);
    if (workerTopLevelTools(active).includes(tool)) {
      const definition = this.firstPartyTool(active, tool);
      return definition.execute(
        active,
        callId,
        definition.decodeArguments(decodeDynamicArguments(args)),
        signal
      );
    }
    if (tool === SHELL_TOOL.name) {
      assertShellWait(active, args, "ms");
      // The approval retry fields are for Auto-review; the command runs without them.
      const { request_smart_mode_approval: requestApproval, smart_mode_block_reason: blockReason, ...shellInput } =
        Schema.decodeUnknownSync(ShellToolInput)(args);
      assertGraphicalShellBoundary(shellInput.command, active.subagentType);
      if (shellInput.machineId && active.subagentType) throw new Error("Graphical subagents cannot target the user's local computer");
      await this.autoReview.reviewShell(active, callId, { ...shellInput, request_smart_mode_approval: requestApproval, smart_mode_block_reason: blockReason }, active.cwd, signal);
      if (shellInput.machineId) {
        return (async () => {
          const result = await this.nativeToolExecutor.externalShell(shellInput, signal);
          if (
            result.details.status === "running" &&
            typeof result.details.shell_id === "string" &&
            typeof result.details.output_path === "string"
          ) {
            await this.hostShellCompletions.register({
              botId: active.botId,
              channelId: active.channelId ?? undefined,
              ...(active.requestSource === "automation" ? { automationRunId: active.runId } : {}),
              machineId: shellInput.machineId!,
              shellId: result.details.shell_id,
              outputPath: result.details.output_path,
              title: (shellInput.description?.trim() || shellInput.command).slice(0, 4000),
            });
          }
          return result;
        })();
      }
      return (async () => {
        const environment =
          active.subagentType === "computerUse"
            ? await this.screens.commandEnvironment(active.screenBotId, active.cwd)
            : undefined;
        const secretEnvironment = await this.processSecrets(active, signal);
        return this.nativeToolExecutor.shell(
          shellInput,
          active.cwd,
          signal,
          environment,
          active.botId,
          {
            channelId: active.channelId,
            secretEnvironment,
            secrets: Object.values(secretEnvironment),
            ...(active.requestSource === "automation" ? { automationRunId: active.runId } : {}),
          }
        );
      })();
    }
    if (tool === READ_TOOL.name) {
      const readInput = Schema.decodeUnknownSync(ReadToolInput)(args);
      if (readInput.machineId) {
        if (active.subagentType) {
          throw new Error("Graphical subagents cannot target the user's local computer");
        }
        return (() =>
          this.nativeToolExecutor.externalRead(readInput, signal))();
      }
      const earlierWriters = [...(this.stepFileWriters.get(active.runId) ?? [])];
      const secrets = Object.values(await this.processSecrets(active, signal));
      const read = () => this.nativeToolExecutor.read(readInput, active.cwd);
      const result = await read().catch(async (error) => {
        // A Read issued beside the Shell call that creates its file waits for that call, then retries once.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !earlierWriters.length) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(earlierWriters),
          new Promise((resolveWait) => (timer = setTimeout(resolveWait, SAME_STEP_READ_WAIT_MS))),
        ]).finally(() => clearTimeout(timer));
        signal?.throwIfAborted();
        return read();
      });
      return {
        ...result,
        content: result.content.map((part) =>
          part.type === "text" ? { ...part, text: redactSecrets(part.text, secrets) } : part
        ),
      };
    }
    if (tool === SCREENSHOT_TOOL.name) {
      const frame = await this.screens.screenshot(active.botId, active.cwd, signal).catch((error) => {
        throw signal?.aborted ? error : new Error(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      const directory = join(this.workspaceRoot, "shared", "screenshots");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${active.botId}-${Date.now()}.png`);
      await writeFile(path, frame, { mode: 0o644 });
      return {
        content: [
          {
            type: "text" as const,
            text: `Screenshot captured from the box desktop.\nScreenshot saved to ${path}, and to show the user the box, attach this file:// path with SendToUser.`,
          },
          {
            type: "image" as const,
            data: frame.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: { width: frame.readUInt32BE(16), height: frame.readUInt32BE(20), path },
      };
    }
    if (tool === GET_DYNAMIC_TOOLS_TOOL.name) {
      return this.getDynamicTools(active, callId, Schema.decodeUnknownSync(GetDynamicToolsInput)(args), signal)
        .catch(referenceError);
    }
    if (tool === CALL_DYNAMIC_TOOL_TOOL.name) {
      const input = Schema.decodeUnknownSync(CallDynamicToolInput)(args);
      // A first-party tool this agent already has directly runs natively, as in the reference.
      if (input.namespace === "cursor" && input.toolName !== GET_DYNAMIC_TOOLS_TOOL.name && input.toolName !== CALL_DYNAMIC_TOOL_TOOL.name &&
          this.directToolNames(active).includes(input.toolName))
        return this.executeOpenTeamTool(active, callId, input.toolName, decodeDynamicArguments(input.arguments), signal).catch(referenceError);
      return this.callDynamicTool(active, callId, input, signal, afterEndTurn).catch(referenceError);
    }
    if (tool === "UpdateRoutine") {
      const refused = await this.autoReview.reviewRoutineWrite(active, callId, args as Record<string, any>, signal);
      if (refused !== undefined) return { content: [{ type: "text", text: `Not saved: ${refused}` }], details: { tool } };
    }

    return this.callControlPlaneTool(active, callId, tool, args, signal);
  }

  private async executeGraphicalAction<T>(active: ActiveTurn, signal: AbortSignal | undefined, execute: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (active.endTurnRequested) throw new Error("The turn has ended");
    return execute();
  }

  private async callComputerUse(
    active: ActiveTurn,
    args: unknown,
    signal?: AbortSignal,
    callId = "computer"
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    signal?.throwIfAborted();
    const input = Schema.decodeUnknownSync(ComputerUseInput)(
      normalizeMainToolArguments("Computer", args)
    );
    await this.autoReview.reviewComputer(active, callId, input, signal);
    const { then = [], description: _description, ...first } = input;
    const requestedActions = [first, ...then];
    const needsDesktopObservation = active.lastGraphicalSurface !== "computer" &&
      requestedActions.some(action => ["click", "move", "drag", "scroll"].includes(action.action));
    const actions = needsDesktopObservation ? [{ action: "screenshot" as const }] : requestedActions;
    const frame = await this.screens.actComputerUse(active.screenBotId, active.cwd, actions, signal).catch((error) => {
      throw signal?.aborted ? error : new Error(`Computer action failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    signal?.throwIfAborted();
    active.lastGraphicalSurface = "computer";
    const directory = join(this.workspaceRoot, "shared", "screenshots");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${active.botId}-computer-${Date.now()}.png`);
    await writeFile(path, frame, { mode: 0o644 });
    return {
      content: [
        {
          type: "text" as const,
          text: `${needsDesktopObservation ? "Captured the native desktop before switching coordinate spaces. The requested pointer actions were NOT executed. Read this screenshot, then issue the actions using desktop coordinates; browser viewport coordinates omit the window chrome." : "Computer action ran on the box desktop."}\nScreenshot of the resulting screen saved to ${path}, and if it should be shown to the user, include this file:// path in your report to the parent.`,
        },
        {
          type: "image" as const,
          data: frame.toString("base64"),
          mimeType: "image/png",
        },
      ],
      details: {
        actions: actions.map((action) => action.action),
        width: frame.readUInt32BE(16),
        height: frame.readUInt32BE(20),
        path,
        coordinateSpace: "desktop",
        ...(needsDesktopObservation ? { requestedActionsSkipped: true } : {}),
      },
    };
  }

  /** Connects the bot's browser on first use, launching Chromium if needed; concurrent callers share one connect. */
  private browserSession(active: ActiveTurn): Promise<BrowserUseSession> {
    const pending = this.browserConnects.get(active.botId);
    if (pending) return pending;
    const connect = (async () => {
      const endpoint = await this.screens.browserEndpointForAgent(active.screenBotId, active.cwd);
      let browser = this.browserUseSessions.get(active.botId);
      if (!browser?.connected) {
        // Reuse only the trusted parent desktop, never a process-wide endpoint.
        // Sequential workers retain tab state and bounded console history.
        browser = [...this.browserUseSessions.entries()].find(([id, session]) =>
          session.connected && this.browserSessionScreens.get(id) === active.screenBotId)?.[1] ?? browser;
      }
      if (!browser?.connected) {
        browser = browser ? await browser.reconnect(endpoint) : await BrowserUseSession.connect(
          endpoint,
          join(this.workspaceRoot, "shared", "screenshots")
        );
        this.browserUseSessions.set(active.botId, browser);
        this.browserSessionScreens.set(active.botId, active.screenBotId);
      }
      return browser;
    })().finally(() => this.browserConnects.delete(active.botId));
    this.browserConnects.set(active.botId, connect);
    return connect;
  }

  /** A computerUse worker almost always starts in the browser, so connect while its first model call runs:
   * the cold launch and attach otherwise sit between that call and the first action's review. */
  prewarmBrowser(active: ActiveTurn): void {
    if (active.subagentType !== "computerUse" || this.browserConnects.has(active.botId)) return;
    const live = [...this.browserUseSessions.entries()].some(([id, session]) =>
      session.connected && (id === active.botId || this.browserSessionScreens.get(id) === active.screenBotId));
    if (!live) this.browserSession(active).catch(() => undefined);
  }

  private async callBrowserUse(
    active: ActiveTurn,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
    callId = toolName
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const browser = await this.browserSession(active);
    this.browserUseSessions.set(active.botId, browser);
    this.browserSessionScreens.set(active.botId, active.screenBotId);
    browser.configureUploads(this.workspaceRoot, [this.agentDir]);
    browser.registerPrivateValues([...(this.privateBrowserValues.get(active.screenBotId) ?? [])]);
    if (this.autoReview.enabled(active) && args && typeof args === "object")
      await this.autoReview.reviewBrowser(active, callId, toolName, args as Record<string, any>, browser.currentPageUrl(), signal);
    const result = await browser.execute(toolName, args, signal);
    active.lastGraphicalSurface = "browser";
    return result;
  }

  private async formBrowser(botId: string, existingEndpoint?: string): Promise<FormBrowser> {
    const sessions = () =>
      [...this.browserUseSessions.entries()].filter(
        ([id, session]) =>
          session.connected && (id === botId || this.browserSessionScreens.get(id) === botId)
      );
    if (!sessions().length) {
      const endpoint = existingEndpoint ?? await this.screens.browserEndpointForAgent(botId, this.workspaceRoot);
      this.browserUseSessions.set(
        botId,
        await BrowserUseSession.connect(endpoint, join(this.workspaceRoot, "shared", "screenshots"))
      );
      this.browserSessionScreens.set(botId, botId);
    }
    const resolveSession = async (binding: FormPageBinding) => {
      const ordered = sessions().sort(
        ([a], [b]) => Number(b === binding.sessionId) - Number(a === binding.sessionId)
      );
      for (const [, session] of ordered)
        if (
          (await session.formPages(binding.domain)).some((page) => page.pageId === binding.pageId)
        )
          return session;
      throw new Error("The verified form tab is unavailable or changed domain");
    };
    return {
      prepare: async (form) => {
        const candidates = new Map<
          string,
          { binding: FormPageBinding; reachable: string[]; failureKinds: Record<string, string> }
        >();
        for (const [sessionId, session] of sessions())
          for (const binding of await session.formPages(form.domain!)) {
            const prepared = await session.prepareForm(binding, form);
            if (
              !candidates.has(binding.pageId) ||
              candidates.get(binding.pageId)!.reachable.length < prepared.reachable.length
            )
              candidates.set(binding.pageId, { binding: { ...binding, sessionId }, ...prepared });
          }
        if (candidates.size !== 1)
          throw Object.assign(new Error(
            candidates.size
              ? "More than one browser tab matches this form domain. Keep the intended tab open and close the other matching tab before requesting the form."
              : "No live browser tab matches the form domain. Open the page before requesting the form."
          ), { kind: candidates.size ? "ambiguous_tab" : "tab_missing" });
        return [...candidates.values()][0]!;
      },
      rebind: async (binding, form) => (await resolveSession(binding)).rebindForm(binding, form),
      canSave: async (binding, field) =>
        (await resolveSession(binding)).formCanSave(binding, field),
      fill: async (binding, field, value) =>
        (await resolveSession(binding)).fillForm(binding, field, value),
      submit: async (binding, field) => (await resolveSession(binding)).submitForm(binding, field),
      snapshot: async (binding) => (await resolveSession(binding)).formSnapshot(binding),
    };
  }

  private rememberBrowserValues(screenBotId: string, values: unknown[]) {
    const saved = this.privateBrowserValues.get(screenBotId) ?? new Set<string>();
    for (const value of values) if (typeof value === "string" && value) saved.add(value);
    this.privateBrowserValues.set(screenBotId, saved);
    for (const [id, session] of this.browserUseSessions)
      if (id === screenBotId || this.browserSessionScreens.get(id) === screenBotId)
        session.registerPrivateValues([...saved]);
  }

  private async privateBrowser(active: ActiveTurn): Promise<BrowserUseSession> {
    const endpoint = await this.screens.browserEndpointForAgent(active.screenBotId, active.cwd);
    await this.formBrowser(active.screenBotId, endpoint);
    const browser = [...this.browserUseSessions.entries()].find(
      ([id, session]) =>
        session.connected &&
        (id === active.screenBotId || this.browserSessionScreens.get(id) === active.screenBotId)
    )?.[1];
    if (!browser) throw new Error("The bot browser is unavailable");
    return browser;
  }

  private async desktopTool(
    active: ActiveTurn,
    name: string,
    args: unknown,
    signal?: AbortSignal,
    callId?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const output = await (() =>
        this.nativeToolExecutor.desktopCapability(
          name,
          active.botId,
          args,
          signal,
          callId,
          active.channelId
        ))();
    if (name === "RequestCookieOriginApproval" && output.kind === "collected") {
      signal?.throwIfAborted();
      let injected = 0,
        failed = output.cookies.length;
      try {
        const browser = await this.privateBrowser(active);
        this.rememberBrowserValues(
          active.screenBotId,
          output.cookies.map((cookie: any) => cookie.value)
        );
        const result = await this.screens.withAgentBrowserInput(
          active.screenBotId,
          active.cwd,
          async (leaseSignal) => {
            signal?.throwIfAborted();
            leaseSignal?.throwIfAborted();
            return browser.importPrivateCookies(output.cookies);
          }
        );
        injected = result.injected;
        failed = result.failed;
      } catch {
        signal?.throwIfAborted();
      }
      const outcome = {
        ...output,
        kind: failed ? "failed" : "completed",
        stage: "inject",
        errorClass: "CookieInjectionFailed",
        injected,
        failed,
        decision: output.decision ?? "approve_once",
      };
      return {
        content: [{ type: "text", text: formatChromeCookieImportOutcome(outcome) }],
        details: { imported: injected, failed },
      };
    }
    if (name === "FetchIMessageAttachment") {
      if (typeof output.bytesBase64 !== "string" || typeof output.filename !== "string")
        throw new Error("Invalid attachment response");
      const bytes = Buffer.from(output.bytesBase64, "base64");
      if (bytes.length > 100 * 1024 * 1024) throw new Error("Attachment exceeds 100 MiB");
      const path = join(
        active.cwd,
        "downloads",
        "messages",
        `${crypto.randomUUID()}-${basename(output.filename).replace(/[^a-zA-Z0-9._-]/g, "_")}`
      );
      await agentFileIO("write", path, signal, bytes);
      const content: AgentToolResult<Record<string, unknown>>["content"] = [
        {
          type: "text",
          text: ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(output.mime)
            ? `${output.filename} (${output.mime})`
            : `${output.filename} (${output.mime}) is on your box at ${path}. Open it with Read.`,
        },
      ];
      if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(output.mime)) {
        const image = await boundToolImage(bytes, output.mime);
        content.push(image);
      }
      return { content, details: { path, sizeBytes: bytes.length } };
    }
    return {
      content: [
        { type: "text", text: renderDesktopResult(name, output, args as Record<string, any>) },
      ],
      details: {},
    };
  }

  private async privateControl(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, any>> {
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId: active.runId,
        botId: active.botId,
        conversationId: active.conversationId,
        channelId: active.channelId,
        deliveryId: active.deliveryId,
        callId,
        tool,
        arguments: args,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(240_000)])
        : AbortSignal.timeout(240_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as any;
      throw new Error(
        body.error?.message ?? `Private transfer service failed (${response.status})`
      );
    }
    return response.json() as Promise<Record<string, any>>;
  }

  private async transferPath(active: ActiveTurn, path: string, write: boolean): Promise<string> {
    const roots = [await realpath(this.workspaceRoot), await realpath(active.cwd)];
    const target = resolve(path);
    const refused = (message: string) =>
      Object.assign(new Error(message), {
        outcome: { kind: write ? "destination_refused" : "source_refused", allowedRoots: roots },
      });
    if (!roots.some((root) => target.startsWith(root + sep)))
      throw refused("File transfer path must be inside the workspace or this bot's directory");
    let existing = write ? dirname(target) : target;
    for (;;) {
      try {
        existing = await realpath(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !write) throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    if (!roots.some((root) => existing === root || existing.startsWith(root + sep)))
      throw refused("File transfer symlink escapes the allowed directory");
    return target;
  }

  private async connectorTransfer(
    active: ActiveTurn,
    callId: string,
    tool: string,
    input: Record<string, any>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const outcomeResult = (
      outcome: Record<string, any>
    ): AgentToolResult<Record<string, unknown>> => ({
      content: [
        {
          type: "text",
          text:
            outcome.kind === "uncertain"
              ? outcome.message
              : (tool === "UploadFile" ? describeUploadFileOutcome : describeDownloadFileOutcome)(
                  outcome,
                  input
                )!,
        },
      ],
      details: { outcome },
    });
    let file: Awaited<ReturnType<typeof spoolFile>> | undefined;
    if (tool === "UploadFile") {
      try {
        const source = agentReadStream(
          await this.transferPath(active, input.sourcePath, false),
          signal
        );
        try {
          file = await spoolFile(source.stream, { signal });
          await source.done;
        } finally {
          source.cancel();
        }
      } catch (error) {
        await file?.cleanup();
        signal?.throwIfAborted();
        if ((error as any).outcome) return outcomeResult((error as any).outcome);
        if (["ENOENT", "ENOTDIR", "EISDIR"].includes((error as any).code))
          return outcomeResult({ kind: "source_missing" });
        throw error;
      }
    }
    try {
      const staged = {
        tool,
        input,
        ...(file ? { sha256: file.sha256, sizeBytes: file.sizeBytes } : {}),
      };
      const prepared = await this.privateControl(
        active,
        callId,
        "PrepareConnectorTransfer",
        staged,
        signal
      );
      if (prepared.outcome) return outcomeResult(prepared.outcome);
      if (tool === "UploadFile" && prepared.status === "completed")
        return {
          content: [
            {
              type: "text",
              text: describeUploadFileOutcome({ kind: "uploaded", ...prepared.result }, input)!,
            },
          ],
          details: { ...prepared.result },
        };
      const envelope = {
        runId: active.runId,
        botId: active.botId,
        conversationId: active.conversationId,
        channelId: active.channelId,
        deliveryId: active.deliveryId,
        callId,
        tool: "ExecuteConnectorTransfer",
        arguments: { ...staged, input: { ...input, connection: prepared.connectionId } },
      };
      const response = await fetch(`${this.serverUrl}/api/v0/internal/connector-transfer`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/octet-stream",
          "x-openteam-transfer": Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        },
        body: file ? Bun.file(file.path) : undefined,
        signal,
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as any;
        throw new Error(
          failure.error?.message ??
            `Transfer failed (${response.status}); inspect the destination before retrying`
        );
      }
      let output: Record<string, any>;
      if (response.headers.get("content-type")?.includes("application/json")) {
        output = (await response.json()) as Record<string, any>;
        if (output.outcome) return outcomeResult(output.outcome);
        if (tool === "DownloadFile") throw new Error("File service returned no download stream");
        return {
          content: [
            {
              type: "text",
              text: describeUploadFileOutcome({ kind: "uploaded", ...output }, input)!,
            },
          ],
          details: { ...output },
        };
      }
      if (tool === "DownloadFile") {
        try {
          output = JSON.parse(
            Buffer.from(
              response.headers.get("x-openteam-transfer-result") ?? "",
              "base64url"
            ).toString()
          );
          const filename = basename(String(output.name)).replace(/[\\/\0]/g, "_");
          const path = await this.transferPath(
            active,
            input.destination.path ??
              join(active.cwd, "downloads", [".", ".."].includes(filename) ? "download" : filename),
            true
          );
          if (!response.body) throw new Error("File service returned no download stream");
          output.sizeBytes = await agentWriteStream(path, response.body, signal);
          output.boxPath = path;
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          if ((error as any).outcome) return outcomeResult((error as any).outcome);
          throw error;
        }
      } else output = (await response.json()) as Record<string, any>;
      return {
        content: [
          {
            type: "text",
            text:
              tool === "UploadFile"
                ? describeUploadFileOutcome({ kind: "uploaded", ...output }, input)!
                : describeDownloadFileOutcome({ kind: "downloaded", ...output }, input)!,
          },
        ],
        details: { ...output },
      };
    } finally {
      await file?.cleanup();
    }
  }

  private async callControlPlaneTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const cleanup: Array<() => Promise<void>> = [];
    try {
      if (tool === "SendToUser" && args && typeof args === "object") {
        const input = args as Record<string, any>;
        const stage = async (url: string) => {
          const file = await stageAttachment(url, {
            workspace: process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace",
            agentData: process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT ?? "/home/box/sand-data",
          }, signal);
          cleanup.push(file.cleanup);
          return file.url;
        };
        if (input.type === "attachment" && typeof input.url === "string") args = { ...input, url: await stage(input.url) };
        else if (input.type === "text" && Array.isArray(input.images)) {
          const images = [];
          for (const image of input.images) images.push({ ...image, url: await stage(image.url) });
          args = { ...input, images };
        }
      }
      if (tool === REQUEST_BOX_HELP_TOOL.name) await this.prepareBoxHelpPage(active, args);
      return await this.callControlPlaneToolRequest(active, callId, tool, args, signal);
    } finally {
      await Promise.all(cleanup.map(fn => fn()));
    }
  }

  /** Best effort: the handoff goes out even when the browser cannot be prepared in time. */
  private async prepareBoxHelpPage(active: ActiveTurn, args: unknown): Promise<void> {
    const target = boxHelpPage((args ?? {}) as { url?: string; domain?: string; idp_domain?: string });
    if (!target) return;
    // Without an address to open, only a browser that is already running is worth checking.
    const running = [...this.browserUseSessions.entries()].some(([id, session]) =>
      session.connected && (id === active.screenBotId || this.browserSessionScreens.get(id) === active.screenBotId));
    if (!target.url && !running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.privateBrowser(active).then((browser) => browser.presentHandoffPage(target)),
        new Promise((resolve) => { timer = setTimeout(resolve, BOX_HELP_PAGE_TIMEOUT_MS); }),
      ]);
    } catch {
      // The user can still find or open the page once they take over.
    } finally {
      clearTimeout(timer);
    }
  }

  private async callControlPlaneToolRequest(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const timeoutMs = USER_PACED_CONTROL_TOOLS.has(tool) ? 24 * 60 * 60_000 : this.toolCallTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response, body: unknown;
    try {
      response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
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
        // Bun's fetch otherwise gives up after 300 seconds, inside the per-call guard.
        timeout: false,
      } as RequestInit);
      const text = await response.text();
      try { body = JSON.parse(text) as unknown; } catch { if (response.ok) throw new Error("OpenTeam tool host returned an unreadable result"); }
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        const name = NATIVE_TOOLS.some((native) => native.name === tool) ? tool : CALL_DYNAMIC_TOOL_TOOL.name;
        throw new Error(`${name === CALL_DYNAMIC_TOOL_TOOL.name ? "Tool execution error. " : ""}${toolCallTimedOutMessage(name, timeoutMs)}`);
      }
      throw error;
    }
    if (!response.ok) throw controlPlaneError(response.status, body);
    if (
      body &&
      typeof body === "object" &&
      (body as any).completed &&
      [
        "InstallPlugin",
        "UninstallPlugin",
        "AddMcpServer",
        "UninstallMcpServer",
        "AuthenticateMcpServer",
        "RestartMcpServers",
        "RemoveMcpAccount",
        "RenameMcpAccount",
        "SetMcpInstructions",
      ].includes(tool)
    ) {
      const fresh = await this.privateControl(
        active,
        `${callId}:catalog`,
        "RefreshToolCatalog",
        {},
        signal
      );
      active.pluginNamespaces = fresh.namespaces;
    }
    if (
      tool === "WakeParent" &&
      body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).woken === true
    ) {
      active.endTurnRequested = true;
      // The handoff ends the automation, so its background commands stop with it.
      const runs = (body as Record<string, unknown>).automation_run_ids;
      this.nativeToolExecutor.stopAutomationShells(Array.isArray(runs) ? runs.filter((id): id is string => typeof id === "string") : [active.runId]);
    }
    // A reaction can be the whole reply: with end_turn, a successful one delivers and ends the turn.
    if (
      tool === REACT_TO_MESSAGE_TOOL.name &&
      (args as { end_turn?: unknown }).end_turn === true &&
      body &&
      typeof body === "object" &&
      ((body as Record<string, unknown>).reacted === true || (body as Record<string, unknown>).removed === true)
    ) {
      markDelivered(active);
      active.endTurnRequested = true;
      active.finishResponseCalls = true;
      active.endTurnCallId = callId;
    }
    if (
      [
        SEND_TO_USER_TOOL.name,
        REQUEST_BOX_HELP_TOOL.name,
        "RequestUserForm",
        "DraftExternalMessage",
        "CreateBotShareJson",
      ].includes(tool) &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).sent === true
    ) {
      markDelivered(active);
      const input = args as { end_turn?: boolean; type?: string };
      const question = tool === SEND_TO_USER_TOOL.name && isQuestionSend(input);
      // end_turn closes the turn only when no earlier send in this response failed.
      const closes = tool === SEND_TO_USER_TOOL.name && input.end_turn === true && !active.failedResponseSends?.size;
      if (question || [REQUEST_BOX_HELP_TOOL.name, "RequestUserForm"].includes(tool)) active.awaitingUser = true;
      if (question || closes || [REQUEST_BOX_HELP_TOOL.name, "RequestUserForm"].includes(tool)) {
        // A question or closing send still runs the rest of its response; a form or box handoff stops it.
        if (question || closes) active.finishResponseCalls = true;
        if (closes) active.endTurnCallId = callId;
        active.endTurnRequested = true;
      }
    }
    if (tool === "PluginCall") {
      const { parts, isError } = connectorResultParts(body);
      const spilled = await spillConnectorText(parts, active.cwd, (path, data) => agentFileIO("write", path, undefined, data));
      return {
        content: spilled.parts,
        details: { tool, ...(isError ? { isError: true } : {}), ...(spilled.outputPath ? { outputPath: spilled.outputPath } : {}) },
        ...(active.endTurnRequested ? { terminate: true } : {}),
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: renderControlResult(tool, body, args as Record<string, any>),
        },
      ],
      details: {
        tool,
        ...(tool === "CheckSubagent" ? {pendingBackgroundWork: onlyPendingBackgroundWork(body)} : {}),
        ...(tool === "TodoWrite" && body && typeof body === "object" && "todos" in body
          ? { todos: body.todos, ...(todoCleanupReminder(body.todos) ? { systemReminders: [todoCleanupReminder(body.todos)] } : {}) }
          : {}),
      },
      ...(active.endTurnRequested ? { terminate: true } : {}),
    };
  }

  private executeTask(
    active: ActiveTurn,
    callId: string,
    args: TaskInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    return this.callControlPlaneTool(active, callId, TASK_TOOL.name, args, signal);
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
      const body = (Array.isArray(result.details.todos) ? result.details : JSON.parse(text)) as {
        todos?: unknown;
      };
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
        return [`- **${todo.status.toUpperCase()}**: ${todo.content} (id: ${todo.id})`];
      });
      active.todoUpdate = lines.length > 0 ? lines.join("\n") : null;
    } catch {
      // Preserve the prior durable snapshot when a nonstandard tool host does
      // not return TodoWrite's documented JSON result.
    }
    return result;
  }

  /** The catalog GetDynamicTools serves: a worker's top-level tools are left out. */
  private dynamicCatalog(
    active: ActiveTurn
  ): Array<DynamicNamespaceDefinition<RuntimeDynamicTool>> {
    const topLevel = workerTopLevelTools(active);
    return this.fullDynamicCatalog(active).map((namespace) => {
      if (namespace.name !== "cursor" || !topLevel.length) return namespace;
      const tools = namespace.tools.filter((tool) => !topLevel.includes(tool.name));
      return { ...namespace, tools, description: firstPartyNamespaceDescription(tools.map((tool) => tool.name), { worker: active.runtimeProfile === "subagent" }) };
    });
  }

  private firstPartyTool(active: ActiveTurn, name: string): RuntimeDynamicTool {
    const tool = this.fullDynamicCatalog(active)
      .find((namespace) => namespace.name === "cursor")
      ?.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown first-party tool: ${name}`);
    return tool;
  }

  private fullDynamicCatalog(
    active: ActiveTurn
  ): Array<DynamicNamespaceDefinition<RuntimeDynamicTool>> {
    return dynamicCatalog(
      (...args) => this.callControlPlaneTool(...args),
      (turn, callId, args, signal) => this.executeTodoWrite(turn, callId, args, signal),
      (...args) => this.executeTask(...args),
      active,
      (turn, _callId, args, signal) => this.awaitShellForTurn(turn, args, signal),
      [
        // Workers that use the parent's connectors move files with them both ways;
        // graphical and media workers have no connector accounts.
        ...((active.runtimeProfile !== "subagent" || subagentUsesParentConnectors(active.subagentType)) && !active.readOnly
          ? CONNECTOR_TRANSFER_TOOLS
          : []
        ).map(
              (definition): RuntimeDynamicTool => ({
                ...definition,
                source: "first-party",
                decodeArguments: (args) => parseConnectorTransfer(definition.name, args),
                execute: (turn, callId, args, signal) =>
                  this.connectorTransfer(
                    turn,
                    callId,
                    definition.name,
                    args as Record<string, any>,
                    signal
                  ),
              })
            ),
        ...(active.runtimeProfile === "subagent" || active.requestSource === "automation"
          ? []
          : DESKTOP_CAPABILITY_TOOLS.map(
              (definition): RuntimeDynamicTool => ({
                ...definition,
                source: "first-party",
                decodeArguments: (args) => parseReferenceArguments(definition.name, args),
                execute: (turn, callId, args, signal) =>
                  this.desktopTool(turn, definition.name, args, signal, callId),
              })
            )),
        ...(active.runtimeProfile === "subagent"
          ? []
          : ["DraftExternalMessage", "CreateBotShareJson"].map(
              (name): RuntimeDynamicTool => {
                const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
                return {
                  name,
                  description: definition.description,
                  inputSchema: definition.inputSchema,
                  source: "first-party",
                  // The captured schema words each argument problem first; then the stored shape and body checks.
                  decodeArguments:
                    name === "DraftExternalMessage"
                      ? (input) => parseDraftExternalMessage(normalizeMainToolArguments(name, input))
                      : (input) => input,
                  execute: (turn, callId, args, signal) => this.callControlPlaneTool(turn, callId, name, args, signal),
                };
              }
            )),
        ...(active.runtimeProfile === "subagent"
          ? []
          : ["RequestUserForm", "RemapUserFormTargets"].map((name): RuntimeDynamicTool => {
              const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
              return {
                name,
                description: definition.description,
                inputSchema: definition.inputSchema,
                source: "first-party",
                decodeArguments:
                  name === "RequestUserForm"
                    ? parseUserForm
                    : (args) => ({ targets: parseFormRemap(args) }),
                execute: async (turn, callId, args, signal) => {
                  if (name === "RequestUserForm")
                    return this.callControlPlaneTool(turn, callId, name, args, signal);
                  const receipt = await this.userForms
                    .remap(turn.botId, args, callId)
                    .catch((error) => {
                      if (
                        error instanceof Error &&
                        error.message === "No held form fields remain for this bot"
                      )
                        return null;
                      throw error;
                    });
                  if (!receipt)
                    return {
                      content: [
                        { type: "text", text: buildUserFormRemapReceipt({ kind: "no_hold" }) },
                      ],
                      details: {},
                    };
                  if (receipt.unknownFieldIds)
                    return {
                      content: [
                        {
                          type: "text",
                          text: buildUserFormRemapReceipt({
                            kind: "unknown_fields",
                            unknownFieldIds: receipt.unknownFieldIds,
                            heldFieldIds: receipt.heldFieldIds,
                          }),
                        },
                      ],
                      details: {},
                    };
                  const recorded = await this.callControlPlaneTool(
                    turn,
                    callId,
                    "RecordUserFormRemap",
                    receipt,
                    signal
                  );
                  await this.userForms.acknowledgeRemap(turn.botId, receipt.formId);
                  const text = recorded.content.find((part) => part.type === "text");
                  const cardOutcome = text?.type === "text" ? JSON.parse(text.text) : undefined;
                  const selected = new Set(
                    (args as any).targets.map((target: any) => target.fieldId)
                  );
                  const output = receipt.interrupted
                    ? formatUserFormReceipt(receipt)
                    : buildUserFormRemapReceipt({
                        kind: "remapped",
                        fillFailureKinds: receipt.fillFailureKinds,
                        domainMismatch: receipt.domainMismatch,
                        outcomes: receipt.fields
                          .filter((field) => selected.has(field.id))
                          .map((field) => ({ id: field.id, filled: field.status === "filled" })),
                        notRemappedFieldIds: receipt.fields
                          .filter((field) => !selected.has(field.id))
                          .map((field) => field.id),
                      });
                  return {
                    content: [{ type: "text", text: output }],
                    details: { formReceipt: receipt, cardOutcome },
                  };
                },
              };
            })),
        ...["WebFetch", "WebSearch"].map((name): RuntimeDynamicTool => {
          const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
          return {
            name,
            description: definition.description,
            inputSchema: definition.inputSchema,
            source: "first-party",
            decodeArguments: (args) => {
              const key = name === "WebFetch" ? "url" : "search_term";
              const value = (args as Record<string, unknown>)?.[key];
              if (typeof value !== "string" || !value.trim() || value.length > 16_000)
                throw new Error(`${key} must be a nonempty string of at most 16000 characters`);
              return value.trim();
            },
            execute: (_turn, _callId, args, signal) =>
              name === "WebFetch"
                ? this.webTools.fetch(args as string, signal)
                : this.webTools.search(args as string, signal),
          };
        }),
        // Registered computers are listed on demand, as in the reference; box-scoped and read-only agents stay on the box.
        ...(active.readOnly || active.subagentType === "computerUse"
          ? []
          : [{
              name: LIST_MACHINES_TOOL.name,
              description: LIST_MACHINES_TOOL.description,
              inputSchema: LIST_MACHINES_TOOL.inputSchema,
              source: "first-party" as const,
              decodeArguments: (args: unknown) => args ?? {},
              execute: (_turn: ActiveTurn, _callId: string, _args: unknown, signal?: AbortSignal) =>
                this.nativeToolExecutor.listMachines(signal),
            }]),
        ...(active.runtimeProfile === "subagent"
          ? []
          : ["CopyToBox", "CopyFromBox"].map((name): RuntimeDynamicTool => {
              const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
              return {
                name,
                description: definition.description,
                inputSchema: definition.inputSchema,
                source: "first-party",
                decodeArguments: (args) => {
                  const value = applyArgumentAliases(name, args) as Record<string, unknown>;
                  const required = name === "CopyToBox" ? "computer_path" : "box_path";
                  if (
                    !value ||
                    typeof value[required] !== "string" ||
                    !String(value[required]).trim() ||
                    typeof value.machineId !== "string" ||
                    !value.machineId.trim()
                  )
                    throw new Error(`${required} and machineId are required`);
                  for (const key of ["computer_path", "box_path"])
                    if (
                      value[key] !== undefined &&
                      (typeof value[key] !== "string" || !String(value[key]).trim())
                    )
                      throw new Error(`${key} must be a nonempty path`);
                  return {
                    machineId: value.machineId,
                    ...(value.box_path ? { box_path: String(value.box_path).trim() } : {}),
                    ...(value.computer_path
                      ? { computer_path: String(value.computer_path).trim() }
                      : {}),
                  };
                },
                execute: (turn, callId, args, signal) =>
                  (() =>
                    this.nativeToolExecutor.copyFile(
                      name === "CopyToBox" ? "toBox" : "fromBox",
                      args as Parameters<NativeToolExecutor["copyFile"]>[1],
                      turn.cwd,
                      signal
                    ))(),
              };
            })),
      ]
    );
  }

  /** Tool names this agent calls directly, outside the cursor namespace. */
  directToolNames(active: ActiveTurn): string[] {
    return this.customTools(active).map((tool) => tool.name);
  }

  /** First-party tools this agent reaches only through CallDynamicTool. */
  cursorToolNames(active: ActiveTurn): string[] {
    return this.dynamicCatalog(active).find((namespace) => namespace.name === "cursor")?.tools.map((tool) => tool.name) ?? [];
  }

  private lookupOptions(active: ActiveTurn): DynamicLookupOptions {
    const canAuthenticate = this.cursorToolNames(active).includes("AuthenticateMcpServer");
    const report = active.requestSource === "automation" && active.runtimeProfile !== "subagent" ? "with WakeParent" : "in your result";
    return {
      directTools: this.directToolNames(active),
      unavailableGuidance: (namespace) =>
        !canAuthenticate
          ? `You cannot do that from here, so report the status ${report} instead of retrying.`
          : namespace.namespaceStatus === "needsAuth"
            ? `Call AuthenticateMcpServer with server_id "${namespace.name}" to show the user its sign-in, then finish unrelated work and end your turn. Don't reach the service another way meanwhile.`
            : "",
    };
  }

  /** A namespace or tool can appear mid-turn (a reconnect, a tool-list change): look once more before failing. */
  private async withCatalogRefresh<T>(active: ActiveTurn, callId: string, lookup: () => T, signal?: AbortSignal): Promise<T> {
    try {
      return lookup();
    } catch (error) {
      if (!(error instanceof DynamicLookupMiss)) throw error;
      const fresh = await this.privateControl(active, `${callId}:catalog`, "RefreshToolCatalog", {}, signal).catch(() => null);
      if (!fresh) throw error;
      active.pluginNamespaces = fresh.namespaces;
      return lookup();
    }
  }

  private async getDynamicTools(
    active: ActiveTurn,
    callId: string,
    input: GetDynamicToolsInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const options = this.lookupOptions(active);
    const result = await this.withCatalogRefresh(active, callId, () =>
      discoverDynamicTools(this.dynamicCatalog(active), input, options), signal);
    const form = result.namespaces
      .flatMap((namespace) => namespace.tools)
      .find((tool) => tool.name === "RequestUserForm");
    if (form && input.namespace && !input.pattern) {
      const keys = await this.userForms.savedExtraKeys();
      form.description +=
        "\n\nVault extras: reuse the exact saved extra_key for the same nonsecret fact across forms; never put a value in the key.\n" +
        (keys.length
          ? "Saved extra keys:\n" + keys.map((key) => `- ${JSON.stringify(key)}`).join("\n")
          : "No saved extra keys yet.");
    }
    // Always inline, as the reference answers in production regardless of size.
    return {
      content: [{ type: "text", text: JSON.stringify(renderDynamicDiscovery(result, input), null, 2) }],
      details: { namespaceCount: result.namespaces.length },
    };
  }

  private async callDynamicTool(
    active: ActiveTurn,
    callId: string,
    input: CallDynamicToolInput,
    signal?: AbortSignal,
    afterEndTurn = false
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (
      active.readOnly &&
      (input.namespace === "cursor"
        ? !["AwaitShell", "WebSearch", "WebFetch", "SearchPlugins", "GetPlugin", "GetMcpServerStatus"].includes(input.toolName)
        : !active.pluginNamespaces.some((namespace) => namespace.name === input.namespace &&
            namespace.tools.some((tool) => tool.name === input.toolName && isReadonlyConnectorRead(tool))))
    )
      throw new Error("This tool is unavailable to a read-only plugin agent");
    const options = this.lookupOptions(active);
    const resolved = await this.withCatalogRefresh(active, callId, () => {
      const catalog = this.dynamicCatalog(active);
      // Like the reference's CallDynamicTool: keys, enum values and envelopes are matched loosely to the
      // advertised schema, then string-encoded booleans, numbers and JSON become its types before validation.
      const firstParty = input.namespace === "cursor"
        ? catalog.find((namespace) => namespace.name === "cursor")?.tools.find((tool) => tool.name === input.toolName)
        : undefined;
      try {
        return resolveDynamicTool(catalog, firstParty && input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
          ? { ...input, arguments: coerceArgumentsToJsonSchema(firstParty.inputSchema,
              normalizeMcpArgumentsToInputSchema(input.arguments, firstParty.inputSchema).arguments) as Record<string, unknown> }
          : input, options);
      } catch (error) {
        const report = invalidArgumentsMessage(error);
        throw report ? new Error(report) : error;
      }
    }, signal);
    // External MCP calls get Auto-review; first-party tools run natively with their own approvals.
    if (resolved.namespace.kind === "mcp") {
      const descriptor = active.pluginNamespaces.find((namespace) => namespace.name === input.namespace)?.tools.find((tool) => tool.name === resolved.tool.name);
      await this.autoReview.reviewMcp(active, callId, {
        namespace: input.namespace,
        serverDisplayName: input.namespace,
        toolName: resolved.tool.name,
        arguments: (resolved.arguments && typeof resolved.arguments === "object" ? resolved.arguments : {}) as Record<string, unknown>,
        toolDescription: resolved.tool.description,
        inputSchema: resolved.tool.inputSchema,
        ...(descriptor?.readOnly === undefined ? {} : { readOnlyHint: descriptor.readOnly }),
        ...(input.mcpDetails ? { details: input.mcpDetails } : {}),
      }, signal);
    }
    const invoke = async () => {
      signal?.throwIfAborted();
      if (resolved.namespace.kind === "mcp") this.autoReview.assertNoPending(active);
      if (afterEndTurn) active.pluginAbortController?.signal.throwIfAborted();
      if (active.endTurnRequested && !afterEndTurn)
        throw new Error("The turn has ended; wait for the next user message");
      const result = resolved.namespace.kind === "mcp"
        ? await resolved.tool.execute(active, callId, resolved.arguments, signal)
            .catch((error) => { throw connectorCallError(error, resolved.namespace, input.toolName, options); })
        : await resolved.tool.execute(active, callId, resolved.arguments, signal);
      return result;
    };
    if (
      input.namespace === "cursor" &&
      [
        "AwaitShell",
        "WebFetch",
        "WebSearch",
        "CheckSubagent",
        "SearchPlugins",
        "GetPlugin",
        "GetMcpServerStatus",
      ].includes(input.toolName)
    )
      return invoke();
    const previous = this.mutationTails.get(active.contextSessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(invoke);
    this.mutationTails.set(active.contextSessionId, result);
    try {
      return await result;
    } finally {
      if (this.mutationTails.get(active.contextSessionId) === result)
        this.mutationTails.delete(active.contextSessionId);
    }
  }
}
