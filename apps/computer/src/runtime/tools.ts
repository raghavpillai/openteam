import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { onlyPendingBackgroundWork } from "./background-status";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { agentReadStream, agentWriteStream } from "../agent-file-stream";
import { stageAttachment } from "../attachment-staging";
import {
  describeOutputLocation,
  buildUserFormRemapReceipt,
} from "@openteam/contracts/reference-formatters";
import { renderDesktopResult, renderControlResult } from "@openteam/contracts/tool-results";
import {
  describeUploadFileOutcome,
  describeDownloadFileOutcome,
  formatChromeCookieImportOutcome,
} from "@openteam/contracts/reference-formatters";
import { parseReferenceArguments } from "@openteam/contracts/reference-parsers";
import { parseDraftExternalMessage } from "@openteam/contracts/external-draft-body";
import { HostShellCompletions } from "../host-shell-completions";
import { expandPluginAgent } from "./plugin-components";
import { skillTool } from "./skill-tool";
import {
  CONNECTOR_TRANSFER_TOOLS,
  CONNECTOR_TRANSFER_MAX_BYTES,
  parseConnectorTransfer,
} from "@openteam/contracts/connector-transfers";
import { createHash } from "node:crypto";
import { DESKTOP_CAPABILITY_TOOLS } from "@openteam/contracts/desktop-capabilities";
import { agentFileIO } from "../agent-file-io";
import { boundToolImage } from "./image-input";
import { redactSecrets } from "@openteam/shell-jobs";
import { validateProcessSecretName } from "@openteam/contracts";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import {
  AwaitShellInput,
  AUTOMATION_PARENT_ONLY_TOOLS,
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
  renderDynamicDiscovery,
  retainedDynamicTools,
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
import { taskToolContract } from "@openteam/contracts/tool-contracts";
import { subagentUsesParentConnectors, taskToolEnabled } from "@openteam/contracts/task-configuration";
import { WebTools } from "../web-tools";
import { SearchProviderClient } from "../search-provider";
import { FetchProviderClient } from "../fetch-provider";
import { serverSearchConfiguration, serverFetchConfiguration } from "../search-settings";
import { UserFormHost, type FormBrowser, type FormPageBinding } from "../user-form-host";
import { boxHelpPage } from "../box-help-page";
import type { ActiveTurn, RuntimeDynamicTool } from "./types";
import { renderShellAwaitResult } from "@openteam/shell-jobs";

export const GRAPHICAL_WORKER_SHELL_DESCRIPTION = [
  "Executes a given command in a shell session with optional foreground timeout.",
  "Use it for commands, scripts, installs, and creating or converting files. Read files with Read rather than `cat`, `head`, or `tail`, search file contents with `rg` rather than `grep` or `find`, and wait for a background command with AwaitShell rather than `sleep`. Before a destructive git step (force-pushing, skipping hooks with `--no-verify`, amending or rebasing commits that are already pushed, `reset --hard`), tell the user what it would overwrite and get their confirmation first, even when they asked for it.",
  "- Do not truncate output with `head`, `tail`, or `sed -n` solely to limit its size; large output is saved to a terminal file.\n- Run independent commands as parallel Shell calls. Chain dependent commands with `&&`.",
].join("\n\n");

export const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on.\n\nText files include line numbers and support offset/limit paging. Image files (jpeg/jpg, png, gif, webp) are returned inline so you can see them. PDF files are converted to text.";

/** How long a handoff waits for the box browser to show the step's page. */
const BOX_HELP_PAGE_TIMEOUT_MS = 12_000;

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

export const SUBAGENT_PRIVATE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "RecallMemory",
  "ListSections",
  SEND_TO_USER_TOOL.name,
  REACT_TO_MESSAGE_TOOL.name,
  UPDATE_MEMORY_TOOL.name,
  UPDATE_ROUTINE_TOOL.name,
  SCREENSHOT_TOOL.name,
]);

/** First-party tools a worker calls directly instead of looking them up with GetDynamicTools. */
export const workerTopLevelTools = (
  active: Pick<ActiveTurn, "subagentType" | "readOnly">
): readonly string[] => {
  if (active.subagentType === "executor" || active.subagentType === "knowledgeWork")
    return active.readOnly ? ["WebSearch", "WebFetch"] : ["AwaitShell", "WebSearch", "WebFetch"];
  if (active.subagentType === "computerUse") return ["AwaitShell"];
  return [];
};

/** Calls that can create a file a Read in the same step is waiting for. */
const SAME_STEP_FILE_WRITERS: ReadonlySet<string> = new Set(["Shell", "AwaitShell", "CopyToBox"]);
const SAME_STEP_READ_WAIT_MS = 120_000;

export class RuntimeTools {
  private readonly shellWaits = new Map<string, Set<AbortController>>();
  private readonly stepFileWriters = new Map<string, Set<Promise<unknown>>>();
  private readonly foregroundShells = new Map<string, Set<{ active: ActiveTurn; controller: AbortController }>>();
  interruptShellWaits(runId: string) {
    for (const wait of this.shellWaits.get(runId) ?? [])
      wait.abort(new Error("A new user message arrived"));
    // A new user message backgrounds a running foreground command so the turn can
    // answer it. A stop (the turn is ending) kills the command instead.
    for (const shell of this.foregroundShells.get(runId) ?? [])
      if (!shell.active.endTurnRequested) shell.controller.abort();
  }

  private async withForegroundShell<T>(active: ActiveTurn, run: (background: AbortSignal) => Promise<T>): Promise<T> {
    const entry = { active, controller: new AbortController() };
    const shells = this.foregroundShells.get(active.runId) ?? new Set();
    shells.add(entry);
    this.foregroundShells.set(active.runId, shells);
    try {
      return await run(entry.controller.signal);
    } finally {
      shells.delete(entry);
      if (!shells.size) this.foregroundShells.delete(active.runId);
    }
  }

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
    const controller = new AbortController();
    const waits = this.shellWaits.get(turn.runId) ?? new Set<AbortController>();
    waits.add(controller);
    this.shellWaits.set(turn.runId, waits);
    const execute = (block_until_ms: number | undefined, waitSignal?: AbortSignal) =>
      input.machineId
        ? this.nativeToolExecutor.externalAwaitShell({ ...input, block_until_ms }, waitSignal)
        : this.nativeToolExecutor.awaitShell({ ...input, block_until_ms }, waitSignal, turn.botId);
    try {
      let result: AgentToolResult<Record<string, unknown>>;
      try {
        result = await execute(
          input.block_until_ms,
          signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        );
      } catch (error) {
        if (!controller.signal.aborted || signal?.aborted) throw error;
        // Released by a new user message: report the job's state now and say why.
        const receipt: ShellAwaitResponse = input.shell_id
          ? ((await execute(0, signal)).details as unknown as ShellAwaitResponse)
          : { status: "slept", waited_ms: Date.now() - started };
        result = {
          content: [{ type: "text", text: renderShellAwaitResult(receipt, true) }],
          details: { ...receipt, released_by_user_message: true },
        };
      }
      if (
        input.machineId &&
        input.shell_id &&
        ["completed", "failed"].includes(String(result.details.status))
      )
        await this.hostShellCompletions.observe(turn.botId, input.machineId, input.shell_id);
      return result;
    } finally {
      waits.delete(controller);
      if (!waits.size) this.shellWaits.delete(turn.runId);
    }
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
    return this.dynamicCatalog(active).map(({ name, description, tools }) => ({
      name,
      description,
      tools: tools.map(({ name }) => ({ name })),
    }));
  }

  async refreshPrompt(active: ActiveTurn, epoch: number) {
    const result = await this.callControlPlaneTool(
      active,
      `${active.runId}:context:${epoch}`,
      "RefreshPromptContext",
      {
        contextSessionId: active.contextSessionId,
        epoch,
        connectorInstructions: active.connectorInstructions ?? "",
      }
    );
    const content = result.content.find((part) => part.type === "text");
    if (content?.type !== "text") throw new Error("Context refresh returned no prompt");
    return JSON.parse(content.text) as {
      instructions: string;
      userInfo: string | null;
      userInfoEpoch: number;
      instructionsUpdate?: string | null;
      ambientContext?: string | null;
      acknowledgement?: unknown;
    };
  }

  async acknowledgePrompt(active: ActiveTurn, acknowledgement: unknown) {
    await this.callControlPlaneTool(
      active,
      `${active.runId}:context-ack:${crypto.randomUUID()}`,
      "AcknowledgePromptContext",
      {
        contextSessionId: active.contextSessionId,
        acknowledgement,
      }
    );
  }

  private readonly privateBrowserValues = new Map<string, Set<string>>();
  private readonly browserUseSessions = new Map<string, BrowserUseSession>();

  private assertCurrentInput(active: ActiveTurn): void {
    // Pi drains steering after the current tool batch. If a correction arrived
    // during inference, do not execute that response's now-stale tool calls first.
    // Leave the queue intact so Pi records the correction before regenerating.
    if (active.pendingSteers?.length) {
      throw new Error(
        "A newer instruction is queued. This tool action was not executed. Process the new instruction before choosing the next action."
      );
    }
  }

  customTools(active: ActiveTurn) {
    if (active.subagentType === "videoReview" || active.subagentType === "watchVideo") return [];
    const native = (
      tool: (typeof NATIVE_TOOLS)[number],
      description: string = tool.description
    ) => {
      if (tool.name === "Task") {
        tool = { ...tool, ...taskToolContract(active.taskConfiguration) };
        description = tool.description;
      }
      const visibleDescription = description;
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
        executionMode: ([
          "Read",
          "Shell",
          "Screenshot",
          "GetDynamicTools",
          "CallDynamicTool",
          "RecallMemory",
          "ListSections",
        ].includes(tool.name)
          ? "parallel"
          : "sequential") as "parallel" | "sequential",
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
          executionMode: "sequential",
          execute: (callId, args, signal) =>
            this.executeGraphicalAction(active, signal, () =>
              this.callComputerUse(active, args, signal)
            ),
        });
    const topLevelTools = () => workerTopLevelTools(active).map((name) => {
      const tool = this.firstPartyTool(active, name);
      return defineTool({
        name,
        label: name,
        description: graphical ? tool.description.replace(MACHINE_ROUTING_AWAIT_SENTENCE, "") : tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(graphical ? boxScopedSchema(tool.inputSchema) : tool.inputSchema),
        executionMode: "parallel",
        execute: (callId: string, args: unknown, signal?: AbortSignal) =>
          this.executeOpenTeamTool(active, callId, name, args, signal),
      });
    });
    const browserTools = () => BROWSER_USE_TOOLS.map((tool) =>
          defineTool({
            name: tool.name,
            label: tool.name,
            description: tool.description,
            parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
            executionMode: "sequential",
            execute: (callId, args, signal) =>
              this.executeGraphicalAction(active, signal, () =>
                this.callBrowserForTurn(active, tool.name, args, signal)
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
        (!active.readOnly ||
          ["Read", "RecallMemory", "GetDynamicTools", "CallDynamicTool", "ListSections"].includes(
            tool.name
          )) &&
        (active.requestSource !== "automation" || !AUTOMATION_PARENT_ONLY_TOOLS.has(tool.name)) &&
        (!active.subagentType || !SUBAGENT_PRIVATE_NATIVE_TOOLS.has(tool.name))
    );
    return [
      ...availableNativeTools.map((tool) => native(tool)),
      ...topLevelTools(),
      // knowledgeWork carries skills of its own; with tool access it loads them with Skill.
      ...(active.subagentType === "knowledgeWork" && active.skillAccess === "tool" ? [skillTool("knowledgeWork")] : []),
    ];
  }

  private async executeOpenTeamTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    this.assertCurrentInput(active);
    const name = tool === CALL_DYNAMIC_TOOL_TOOL.name ? (args as { toolName?: unknown } | null)?.toolName : tool;
    if (typeof name !== "string" || !SAME_STEP_FILE_WRITERS.has(name))
      return this.executeScopedTool(active, callId, tool, args, signal);
    // Calls issued in one step start in order, so a later Read in the step can wait for these.
    const run = this.executeScopedTool(active, callId, tool, args, signal);
    const writers = this.stepFileWriters.get(active.runId) ?? new Set<Promise<unknown>>();
    writers.add(run);
    this.stepFileWriters.set(active.runId, writers);
    try {
      return await run;
    } finally {
      writers.delete(run);
      if (!writers.size) this.stepFileWriters.delete(active.runId);
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
      !["Read", "RecallMemory", "GetDynamicTools", "CallDynamicTool", "ListSections"].includes(tool) &&
      !workerTopLevelTools(active).includes(tool)
    )
      throw new Error("This plugin agent is read-only");
    if (active.readOnly && tool === "Read" && (args as Record<string, unknown>).machineId)
      throw new Error("Read-only agents cannot access the user's computer");
    signal?.throwIfAborted();
    active.pluginAbortController?.signal.throwIfAborted();
    const queuedAttachment = tool === SEND_TO_USER_TOOL.name &&
      (args as { type?: string } | null)?.type === "attachment" &&
      active.pendingDeliveryAttachments?.get(callId) === JSON.stringify(args);
    const queuedCleanup = tool === CALL_DYNAMIC_TOOL_TOOL.name &&
      active.pendingDeliveryCleanup?.get(callId) === JSON.stringify(args);
    const finishCleanup = active.endTurnRequested === true && active.finishDeliveryAttachments === true && queuedCleanup;
    if (active.endTurnRequested && !(active.finishDeliveryAttachments && queuedAttachment) && !finishCleanup)
      throw new Error("The turn has ended after delivery; wait for the next user message.");
    // Consume once, even on failure. This is not a retry or a new action grant.
    if (queuedAttachment) active.pendingDeliveryAttachments?.delete(callId);
    if (queuedCleanup) active.pendingDeliveryCleanup?.delete(callId);
    if (active.requestSource === "automation" && AUTOMATION_PARENT_ONLY_TOOLS.has(tool)) {
      throw new Error("Use WakeParent to hand this communication to the parent agent");
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
      const shellInput = Schema.decodeUnknownSync(ShellToolInput)(args);
      assertGraphicalShellBoundary(shellInput.command, active.subagentType);
      if (shellInput.machineId) {
        if (active.subagentType) {
          throw new Error("Graphical subagents cannot target the user's local computer");
        }
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
      return this.withForegroundShell(active, async (background) => {
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
            background,
            ...(active.requestSource === "automation" ? { automationRunId: active.runId } : {}),
          }
        );
      });
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
    if (tool === LIST_MACHINES_TOOL.name) {
      return this.nativeToolExecutor.listMachines(signal);
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
      return this.getDynamicTools(active, Schema.decodeUnknownSync(GetDynamicToolsInput)(args));
    }
    if (tool === CALL_DYNAMIC_TOOL_TOOL.name) {
      return this.callDynamicTool(
        active,
        callId,
        Schema.decodeUnknownSync(CallDynamicToolInput)(args),
        signal,
        finishCleanup
      );
    }

    return this.callControlPlaneTool(active, callId, tool, args, signal);
  }

  private async executeGraphicalAction<T>(active: ActiveTurn, signal: AbortSignal | undefined, execute: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    this.assertCurrentInput(active);
    if (active.endTurnRequested) throw new Error("The turn has ended");
    return execute();
  }

  private async callComputerUse(
    active: ActiveTurn,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    signal?.throwIfAborted();
    const input = Schema.decodeUnknownSync(ComputerUseInput)(
      normalizeMainToolArguments("Computer", args)
    );
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

  private async callBrowserForTurn(active: ActiveTurn, name: string, args: unknown, signal?: AbortSignal) {
    if (name !== "browser_wait_for" && name !== "browser_run_code") return this.callBrowserUse(active, name, args, signal);
    const controller = new AbortController();
    const waits = this.shellWaits.get(active.runId) ?? new Set<AbortController>();
    waits.add(controller);
    this.shellWaits.set(active.runId, waits);
    try {
      return await this.callBrowserUse(active, name, args, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    } finally {
      waits.delete(controller);
      if (!waits.size) this.shellWaits.delete(active.runId);
    }
  }

  private async callBrowserUse(
    active: ActiveTurn,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
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
    this.browserUseSessions.set(active.botId, browser);
    this.browserSessionScreens.set(active.botId, active.screenBotId);
    browser.configureUploads(this.workspaceRoot, [this.agentDir]);
    browser.registerPrivateValues([...(this.privateBrowserValues.get(active.screenBotId) ?? [])]);
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
    signal?: AbortSignal,
    foregroundYield = false
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(
      [
        "Task",
        "SendFeedback",
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
        ? 24 * 60 * 60_000
        : tool === "SendToUser"
          ? 5 * 60_000
          : ["RequestUserForm", "DraftExternalMessage"].includes(tool)
            ? 120_000
            : 30_000
    );
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(foregroundYield ? {foregroundYield: true} : {}),
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
          : `OpenTeam tool host rejected the call (${response.status})`;
      throw new Error(message);
    }
    if (
      tool === "Task" &&
      body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).foregroundPending === true
    ) {
      if (active.pendingSteers.length > 0) {
        return this.callControlPlaneToolRequest(active, callId, tool, args, requestSignal, true);
      }
      return this.callControlPlaneTool(active, callId, tool, args, requestSignal);
    }
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
    )
      active.endTurnRequested = true;
    // A reaction can be the whole reply: with end_turn, a successful one delivers and ends the turn.
    if (
      tool === REACT_TO_MESSAGE_TOOL.name &&
      (args as { end_turn?: unknown }).end_turn === true &&
      body &&
      typeof body === "object" &&
      ((body as Record<string, unknown>).reacted === true || (body as Record<string, unknown>).removed === true)
    ) {
      active.sentMessageCount += 1;
      active.toolActivityAfterLastSend = false;
      active.endTurnRequested = true;
    }
    if (
      [
        SEND_TO_USER_TOOL.name,
        REQUEST_BOX_HELP_TOOL.name,
        "RequestUserForm",
        "DraftExternalMessage",
        "SendFeedback",
        "CreateBotShareJson",
      ].includes(tool) &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).sent === true
    ) {
      active.sentMessageCount += 1;
      active.toolActivityAfterLastSend = false;
      const input = args as { end_turn?: boolean; type?: string };
      if (
        input.end_turn === true ||
        input.type === "widget" ||
        input.type === "secret-request" ||
        [REQUEST_BOX_HELP_TOOL.name, "RequestUserForm", "SendFeedback"].includes(tool)
      ) {
        if (tool === SEND_TO_USER_TOOL.name && input.type === "text" && input.end_turn === true)
          active.finishDeliveryAttachments = true;
        active.endTurnRequested = true;
      }
    }
    // A plugin's MCP image content reaches the model as images, like native screenshots,
    // instead of base64 text inside the rendered JSON.
    const content = tool === "PluginCall" && body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).content)
      ? ((body as Record<string, unknown>).content as unknown[]) : [];
    const images = content.filter((part): part is { type: "image"; data: string; mimeType: string } =>
      !!part && typeof part === "object" && (part as any).type === "image" && typeof (part as any).data === "string" && typeof (part as any).mimeType === "string");
    const rendered = images.length
      ? { ...(body as Record<string, unknown>), content: content.map(part => images.includes(part as any) ? { type: "image", mimeType: (part as any).mimeType, attachedBelow: true } : part) }
      : body;
    return {
      content: [
        {
          type: "text" as const,
          text: renderControlResult(tool, rendered, args as Record<string, any>),
        },
        ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      ],
      details: {
        tool,
        ...(tool === "CheckSubagent" ? {pendingBackgroundWork: onlyPendingBackgroundWork(body)} : {}),
        ...(tool === "TodoWrite" && body && typeof body === "object" && "todos" in body
          ? { todos: body.todos }
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
    return (async () => {
      return this.callControlPlaneTool(active, callId, TASK_TOOL.name, args, signal);
    })();
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
        return [`- [${todo.status}] ${todo.id}: ${todo.content}`];
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
    return this.fullDynamicCatalog(active).map((namespace) =>
      namespace.name === "cursor" && topLevel.length
        ? { ...namespace, tools: namespace.tools.filter((tool) => !topLevel.includes(tool.name)) }
        : namespace
    );
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
        ...(active.runtimeProfile !== "subagent" || subagentUsesParentConnectors(active.subagentType)
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
          : ["DraftExternalMessage", "SendFeedback", "CreateBotShareJson"].map(
              (name): RuntimeDynamicTool => {
                const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
                return {
                  name,
                  description: definition.description,
                  inputSchema: definition.inputSchema,
                  source: "first-party",
                  decodeArguments:
                    name === "DraftExternalMessage" ? parseDraftExternalMessage : (input) => input,
                  execute: (turn, callId, args, signal) =>
                    this.callControlPlaneTool(turn, callId, name, args, signal),
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
            execute: (turn, _callId, args, signal) =>
              name === "WebFetch"
                ? this.webTools.fetch(args as string, turn.cwd, signal)
                : this.webTools.search(args as string, signal),
          };
        }),
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
                  const value = args as Record<string, unknown>;
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

  private async getDynamicTools(
    active: ActiveTurn,
    input: GetDynamicToolsInput
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const result = discoverDynamicTools(
      this.dynamicCatalog(active),
      active.discoveredDynamicTools,
      input
    );
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
    const text = JSON.stringify(renderDynamicDiscovery(result, input), null, 2);
    if (!input.toolName && Buffer.byteLength(text) > 12_000) {
      const outputPath = join(
        active.cwd,
        ".openteam",
        "dynamic-tools",
        `${crypto.randomUUID()}.json`
      );
      await agentFileIO("write", outputPath, undefined, Buffer.from(text));
      return {
        content: [
          {
            type: "text",
            text: describeOutputLocation(
              {
                filePath: outputPath,
                sizeBytes: Buffer.byteLength(text),
                lineCount: text.split("\n").length,
              },
              {}
            ),
          },
        ],
        details: { namespaceCount: result.namespaces.length, outputPath },
      };
    }
    return {
      content: [{ type: "text", text }],
      details: { namespaceCount: result.namespaces.length },
    };
  }

  private async callDynamicTool(
    active: ActiveTurn,
    callId: string,
    input: CallDynamicToolInput,
    signal?: AbortSignal,
    finishCleanup = false
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (
      active.readOnly &&
      (input.namespace !== "cursor" ||
        ![
          "WebSearch",
          "WebFetch",
          "SearchPlugins",
          "GetPlugin",
          "GetMcpServerStatus",
        ].includes(input.toolName))
    )
      throw new Error("This tool is unavailable to a read-only plugin agent");
    const catalog = this.dynamicCatalog(active);
    const receipts = active.discoveredDynamicTools.has(`${input.namespace}/${input.toolName}`)
      ? active.discoveredDynamicTools
      : new Set([...active.discoveredDynamicTools, ...retainedDynamicTools(catalog, active.dynamicDiscoveryMessages ?? [])]);
    const resolved = resolveDynamicTool(catalog, receipts, input);
    const invoke = async () => {
      signal?.throwIfAborted();
      if (finishCleanup) {
        this.assertCurrentInput(active);
        active.pluginAbortController?.signal.throwIfAborted();
      }
      if (active.endTurnRequested && !finishCleanup)
        throw new Error("The turn has ended; wait for the next user message");
      const result = await resolved.tool.execute(active, callId, resolved.arguments, signal);
      return finishCleanup && !("isError" in result && result.isError)
        ? {...result, details: {...result.details, deliveryCleanup: true}}
        : result;
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
