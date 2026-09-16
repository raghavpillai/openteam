import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { agentReadStream, agentWriteStream } from "../agent-file-stream";
import { describeOutputLocation, buildUserFormRemapReceipt } from "@openteam/contracts/reference-formatters";
import { renderDesktopResult, renderControlResult } from "@openteam/contracts/tool-results";
import { describeUploadFileOutcome, describeDownloadFileOutcome, formatCookieOriginApprovalOutcome } from "@openteam/contracts/reference-formatters";
import { parseReferenceArguments } from "@openteam/contracts/reference-parsers";
import { HostShellCompletions } from "../host-shell-completions";
import { expandPluginAgent } from "./plugin-components";
import { CONNECTOR_TRANSFER_TOOLS, CONNECTOR_TRANSFER_MAX_BYTES, parseConnectorTransfer } from "@openteam/contracts/connector-transfers";
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
  type ApprovalDecision,
  CALL_DYNAMIC_TOOL_TOOL,
  CallDynamicToolInput,
  COMPUTER_USE_TOOL,
  CURSOR_TOOLS,
  parseExternalDraft,
  parseUserForm,
  parseFormRemap,
  formatUserFormReceipt,
  ComputerUseInput,
  EXTERNAL_READ_TOOL,
  EXTERNAL_SHELL_TOOL,
  GET_DYNAMIC_TOOLS_TOOL,
  GetDynamicToolsInput,
  LIST_MACHINES_TOOL,
  NATIVE_TOOLS,
  REACT_TO_MESSAGE_TOOL,
  READ_TOOL,
  ReadToolInput,
  REQUEST_BOX_HELP_TOOL,
  SCREENSHOT_TOOL,
  SEND_TO_USER_TOOL,
  SHELL_TOOL,
  ShellToolInput,
  TASK_TOOL,
  type TaskInput,
  TODO_WRITE_TOOL,
  UPDATE_STATE_TOOL,
} from "@openteam/contracts";
import { Schema } from "effect";
import { parseHostAwaitShellRequest } from "@openteam/contracts/service-protocol";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, basename, resolve, dirname, sep } from "node:path";
import { Type } from "typebox";
import { BROWSER_USE_TOOLS, BrowserUseSession } from "../browser/use";
import {
  discoverDynamicTools,
  renderDynamicDiscovery,
  type DynamicNamespaceDefinition,
  resolveDynamicTool,
} from "../dynamic-tool-gateway";
import { assertGraphicalShellBoundary } from "../graphical-shell-policy";
import {
  HostApprovalRequiredError,
  type HostApprovalTokens,
  NativeToolExecutor,
} from "../native-tool-executor";
import type { ScreenBroker } from "../screen-broker";
import { dynamicCatalog } from "./dynamic-catalog";
import { WebTools } from "../web-tools";
import { SearchProviderClient } from "../search-provider";
import { FetchProviderClient } from "../fetch-provider";
import { serverSearchConfiguration, serverFetchConfiguration } from "../search-settings";
import { UserFormHost, type FormBrowser, type FormPageBinding } from "../user-form-host";
import type { ActiveTurn, RuntimeDynamicTool } from "./types";

export const GRAPHICAL_WORKER_SHELL_DESCRIPTION =
  "Executes a command in this worker's box with an optional foreground timeout. Use Shell for terminal operations and bulk file processing; use Read for reading, searching, or inspecting files. Run independent commands in parallel and chain dependent commands with &&. If shell text search is necessary, use rg rather than grep or find.";

export const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on. Text files include line numbers and support offset/limit paging. Image files are returned inline, and PDF files are converted to text.";

export const SUBAGENT_PRIVATE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "RecallMemory",
  "ListSections",
  SEND_TO_USER_TOOL.name,
  REACT_TO_MESSAGE_TOOL.name,
  UPDATE_STATE_TOOL.name,
]);

export const LEGACY_EXTERNAL_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  EXTERNAL_SHELL_TOOL.name,
  EXTERNAL_READ_TOOL.name,
]);

export class RuntimeTools {
  private readonly turnSecrets = new WeakMap<ActiveTurn, Record<string, string>>();

  private async processSecrets(active: ActiveTurn, signal?: AbortSignal): Promise<Record<string, string>> {
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: active.runId, botId: active.botId, conversationId: active.conversationId,
        channelId: active.channelId, deliveryId: active.deliveryId, callId: `${active.runId}:process-secrets`, tool: "ReadProcessSecrets", arguments: {} }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Process credential configuration could not be loaded");
    const result = await response.json() as { environment?: Record<string, unknown> };
    if (!result.environment || typeof result.environment !== "object" || Array.isArray(result.environment)) throw new Error("Invalid process credential configuration");
    const environment = Object.fromEntries(Object.entries(result.environment).map(([key, value]) => {
      if (typeof value !== "string") throw new Error("Invalid process credential configuration");
      return [validateProcessSecretName(key), value];
    }));
    this.turnSecrets.set(active, environment);
    return environment;
  }
  cancelApprovals(runId: string): void {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.runId === runId) {
        pending.settle(undefined, new Error("The run ended before the approval was resolved"));
      }
    }
  }
  constructor(
    private readonly screens: ScreenBroker,
    private readonly serverUrl: string,
    private readonly controlToken: string,
    private readonly agentDir: string,
    private readonly workspaceRoot: string
  ) {
    this.webTools = new WebTools(
      new SearchProviderClient(serverSearchConfiguration(serverUrl, controlToken)),
      new FetchProviderClient(serverFetchConfiguration(serverUrl, controlToken))
    );
    this.userForms = new UserFormHost(join(agentDir, "private-user-forms"), (botId) => this.formBrowser(botId));
    const deliverShellCompletion = async (completion: import("@openteam/contracts").ShellCompletionInput) => {
      if (!completion.scope) return;
      const response = await fetch(`${this.serverUrl}/api/v0/internal/shell-completions`, {
        method: "POST", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify(completion), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Shell completion delivery failed (${response.status})`);
    };
    this.nativeToolExecutor = new NativeToolExecutor({ agentDir, controlToken, serverUrl: this.serverUrl, onShellComplete: deliverShellCompletion });
    this.hostShellCompletions = new HostShellCompletions(join(agentDir, "private-host-shells"), async (job) => {
      const result = await this.nativeToolExecutor.externalAwaitShell({ machineId: job.machineId, shell_id: job.shellId, block_until_ms: 0 });
      return result.details as unknown as import("@openteam/contracts/service-protocol").ShellAwaitResponse;
    }, deliverShellCompletion);
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
      const recorded = await this.callControlPlaneTool(active, `form-recovery:${receipt.formId}`, "RecordUserFormRemap", receipt);
      const resultText = recorded.content.find((part) => part.type === "text");
      const cardOutcome = resultText?.type === "text" ? JSON.parse(resultText.text) : undefined;
      const key = `form-recovery:${receipt.formId}:${JSON.stringify(receipt)}`;
      if (!active.session.messages.some((message) => message.role === "custom" && (message.details as { messageId?: string })?.messageId === key)) await active.session.sendCustomMessage({ customType: "openteam-card-outcome", content: formatUserFormReceipt(receipt), display: false, details: { messageId: key, origin: "host", cardOutcome } }, { triggerTurn: false });
      await this.userForms.acknowledgeRemap(active.botId, receipt.formId);
    }
  }

  async acknowledgeToolOutcomes(active: ActiveTurn, messages: readonly import("../bot-compaction").BotMessage[]) {
    const receipts = messages.flatMap((message) => {
      const item = message as { role: string; details?: { cardOutcome?: { messageId: string; outcomeId: string } } };
      return ["toolResult", "custom"].includes(item.role) && item.details?.cardOutcome ? [item.details.cardOutcome] : [];
    }).filter((receipt) => !active.acknowledgedCardOutcomes?.has(receipt.outcomeId));
    if (!receipts.length) return;
    try { await this.callControlPlaneTool(active, `${active.runId}:card-outcomes`, "AcknowledgeCardOutcomes", { receipts }); } catch { return; }
    active.acknowledgedCardOutcomes ??= new Set();
    for (const receipt of receipts) active.acknowledgedCardOutcomes.add(receipt.outcomeId);
  }

  contextCatalog(active: ActiveTurn) {
    return this.dynamicCatalog(active).map(({ name, description, tools }) => ({
      name, description, tools: tools.map(({ name }) => ({ name })),
    }));
  }

  async refreshPrompt(active: ActiveTurn, epoch: number) {
    const result = await this.callControlPlaneTool(active, `${active.runId}:context:${epoch}`, "RefreshPromptContext", {
      contextSessionId: active.contextSessionId,
      epoch,
      connectorInstructions: active.connectorInstructions ?? "",
    });
    const content = result.content.find((part) => part.type === "text");
    if (content?.type !== "text") throw new Error("Context refresh returned no prompt");
    return JSON.parse(content.text) as {
      instructions: string; userInfo: string | null; userInfoEpoch: number;
      instructionsUpdate?: string | null; ambientContext?: string | null; acknowledgement?: unknown;
    };
  }

  async acknowledgePrompt(active: ActiveTurn, acknowledgement: unknown) {
    await this.callControlPlaneTool(active, `${active.runId}:context-ack:${crypto.randomUUID()}`, "AcknowledgePromptContext", {
      contextSessionId: active.contextSessionId, acknowledgement,
    });
  }

  private readonly privateBrowserValues = new Map<string, Set<string>>();
  private readonly browserUseSessions = new Map<string, BrowserUseSession>();

  private readonly pendingApprovals = new Map<
    string,
    {
      runId: string;
      settle: (decision?: ApprovalDecision, error?: Error) => void;
    }
  >();

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error("This approval is no longer pending");
    pending.settle(decision);
  }

  customTools(active: ActiveTurn) {
    const native = (
      tool: (typeof NATIVE_TOOLS)[number],
      description: string = tool.description
    ) => {
      const visibleDescription = description;
      return defineTool({
        name: tool.name,
        label: tool.name,
        description: visibleDescription,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.name === "Task" && active.pluginRuntimePackages?.some(pkg => pkg.agents.length) ? { ...tool.inputSchema, properties: { ...(tool.inputSchema as any).properties, plugin_agent: { type: "string", description: "Installed plugin agent template, plugin:agent" } } } : tool.inputSchema),
        executionMode: (["Read", "Shell", "Screenshot", "GetDynamicTools", "CallDynamicTool", "RecallMemory", "ListSections"].includes(tool.name) ? "parallel" : "sequential") as "parallel" | "sequential",
        execute: (callId: string, args: unknown, signal?: AbortSignal) =>
          this.executeOpenTeamTool(active, callId, tool.name, args, signal),
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
        (!active.readOnly || ["Read", "RecallMemory", "GetDynamicTools", "CallDynamicTool", "ListSections"].includes(tool.name)) &&
        !LEGACY_EXTERNAL_NATIVE_TOOLS.has(tool.name) &&
        (active.requestSource !== "automation" || !AUTOMATION_PARENT_ONLY_TOOLS.has(tool.name)) &&
        (!active.subagentType || !SUBAGENT_PRIVATE_NATIVE_TOOLS.has(tool.name))
    );
    return availableNativeTools.map((tool) => native(tool));
  }

  private async executeOpenTeamTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    args = normalizeMainToolArguments(tool,args);
    if (tool === "Task") args = expandPluginAgent(active.pluginRuntimePackages ?? [], args as Record<string, unknown>);
    if (active.readOnly && !["Read", "RecallMemory", "GetDynamicTools", "CallDynamicTool", "ListSections"].includes(tool)) throw new Error("This plugin agent is read-only");
    if (active.readOnly && tool === "Read" && (args as Record<string, unknown>).machineId) throw new Error("Read-only agents cannot access the user's computer");
    if (active.endTurnRequested) throw new Error("The turn has ended after delivery; wait for the next user message.");
    if (active.requestSource === "automation" && AUTOMATION_PARENT_ONLY_TOOLS.has(tool)) {
      throw new Error("Use WakeParent to hand this communication to the parent agent");
    }
    if (tool === SEND_TO_USER_TOOL.name && (args as Record<string, unknown>)?.type === "credential-request") {
      if (active.runtimeProfile === "subagent" || active.requestSource === "automation") throw new Error("Saved-login approval must be requested by the parent bot");
      const credential = (args as { credential?: Record<string, unknown> }).credential;
      if (!credential || credential.kind !== "browser-login" || ["credential_id", "connection_id", "catalog_revision", "site", "purpose"].some(key => typeof credential[key] !== "string" || !credential[key])) throw new Error("Invalid credential-request");
      const {browser, binding} = await this.privateLoginBinding(active, credential.site as string);
      try {
        const values = await this.nativeToolExecutor.desktopCapability("UseSavedCredential", active.screenBotId, { ...credential, site: binding.origin }, signal);
        signal?.throwIfAborted();
        this.rememberBrowserValues(active.screenBotId, [values.password, values.username]);
        const filled = await this.screens.withAgentBrowserInput(active.screenBotId, active.cwd, async (leaseSignal) => {
          signal?.throwIfAborted(); leaseSignal?.throwIfAborted();
          return browser.fillSavedLogin(binding, values as { origin: string; password: string; username?: string });
        });
        return { content: [{ type: "text", text: filled ? "Approved login filled on the bound page. Continue in the browser to submit; values were kept private." : "The approved login document or fields changed. Inspect the page before requesting further help." }], details: { filled, origin: binding.origin } };
      } finally { await browser.releaseLoginBinding(binding); }
    }
    if (tool === SHELL_TOOL.name) {
      const shellInput = Schema.decodeUnknownSync(ShellToolInput)(args);
      assertGraphicalShellBoundary(shellInput.command, active.subagentType);
      if (shellInput.machineId) {
        if (active.subagentType) {
          throw new Error("Graphical subagents cannot target the user's local computer");
        }
        return this.executeHostTool(active, callId, tool, signal, async (approvals) => {
          const result = await this.nativeToolExecutor.externalShell(shellInput, signal, approvals);
          if (result.details.status === "running" && typeof result.details.shell_id === "string" && typeof result.details.output_path === "string") {
            await this.hostShellCompletions.register({ botId: active.botId, channelId: active.channelId ?? undefined, ...(active.requestSource === "automation" ? { automationRunId: active.runId } : {}), machineId: shellInput.machineId!, shellId: result.details.shell_id, outputPath: result.details.output_path });
          }
          return result;
        });
      }
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
        { channelId: active.channelId, secretEnvironment, secrets: Object.values(secretEnvironment), ...(active.requestSource === "automation" ? { automationRunId: active.runId } : {}) }
      );
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
      const secrets = Object.values(await this.processSecrets(active, signal));
      const result = await this.nativeToolExecutor.read(readInput, active.cwd);
      return { ...result, content: result.content.map(part => part.type === "text" ? { ...part, text: redactSecrets(part.text, secrets) } : part) };
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
            text: `Screenshot captured from the box desktop.\nScreenshot saved to ${path} — attach this file:// path with SendToUser to show the user the box.`,
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

  async approvePluginHook(active: ActiveTurn, callId: string, reason: string, input: Record<string, unknown>): Promise<boolean> {
    const decision = await this.requestHostApproval(active, callId, new HostApprovalRequiredError({ gate: "auto-review", requestMethod: "openteam/autoReview", details: { type: "autoReview", gate: "auto-review", action: "mcp", toolName: String(input.tool_name ?? "plugin hook"), summary: reason, reason: "An installed plugin requires review", arguments: input, supportsAlwaysAllow: false } }), active.pluginAbortController?.signal);
    return decision === "accept";
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
    const input = Schema.decodeUnknownSync(ComputerUseInput)(normalizeMainToolArguments("Computer",args));
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
          text: `Computer action ran on the box desktop.\nScreenshot of the resulting screen saved to ${path} — include this file:// path in your report to the parent if it should be shown to the user.`,
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
      this.browserSessionScreens.set(active.botId, active.screenBotId);
    }
    browser.registerPrivateValues([...(this.privateBrowserValues.get(active.screenBotId) ?? [])]);
    const result = await browser.execute(toolName, args);
    if (["browser_navigate", "browser_snapshot", "browser_tabs"].includes(toolName) && active.requestSource !== "automation") {
      const filled = await this.automaticLogin(active, browser);
      if (filled) return browser.execute("browser_snapshot", {});
    }
    return result;
  }

  private async formBrowser(botId: string): Promise<FormBrowser> {
    const sessions = () => [...this.browserUseSessions.entries()].filter(([id, session]) => session.connected && (id === botId || this.browserSessionScreens.get(id) === botId));
    if (!sessions().length) {
      const endpoint = await this.screens.browserEndpointForAgent(botId, this.workspaceRoot);
      this.browserUseSessions.set(botId, await BrowserUseSession.connect(endpoint, join(this.workspaceRoot, "shared", "screenshots"), true));
      this.browserSessionScreens.set(botId, botId);
    }
    const resolveSession = async (binding: FormPageBinding) => {
      const ordered = sessions().sort(([a], [b]) => Number(b === binding.sessionId) - Number(a === binding.sessionId));
      for (const [, session] of ordered) if ((await session.formPages(binding.domain)).some((page) => page.pageId === binding.pageId)) return session;
      throw new Error("The verified form tab is unavailable or changed domain");
    };
    return {
      prepare: async (form) => {
        const candidates = new Map<string, { binding: FormPageBinding; reachable: string[] }>();
        for (const [sessionId, session] of sessions()) for (const binding of await session.formPages(form.domain!)) {
          const reachable = await session.prepareForm(binding, form);
          if (!candidates.has(binding.pageId) || candidates.get(binding.pageId)!.reachable.length < reachable.length) candidates.set(binding.pageId, { binding: { ...binding, sessionId }, reachable });
        }
        if (candidates.size !== 1) throw new Error(candidates.size ? "More than one browser tab matches this form domain. Keep the intended tab open and close the other matching tab before requesting the form." : "No live browser tab matches the form domain. Open the page before requesting the form.");
        return [...candidates.values()][0]!;
      },
      canSave: async (binding, field) => (await resolveSession(binding)).formCanSave(binding, field),
      fill: async (binding, field, value) => (await resolveSession(binding)).fillForm(binding, field, value),
      submit: async (binding, field) => (await resolveSession(binding)).submitForm(binding, field),
      snapshot: async (binding) => (await resolveSession(binding)).formSnapshot(binding),
    };
  }

  private rememberBrowserValues(screenBotId: string, values: unknown[]) {
    const saved = this.privateBrowserValues.get(screenBotId) ?? new Set<string>();
    for (const value of values) if (typeof value === "string" && value) saved.add(value);
    this.privateBrowserValues.set(screenBotId, saved);
    for (const [id, session] of this.browserUseSessions) if (id === screenBotId || this.browserSessionScreens.get(id) === screenBotId) session.registerPrivateValues([...saved]);
  }
  private async privateLoginBinding(active: ActiveTurn, site: string) {
    await this.privateBrowser(active);
    const matches: Array<{browser: BrowserUseSession; binding: Awaited<ReturnType<BrowserUseSession["loginBinding"]>>}> = [];
    for (const [id, browser] of this.browserUseSessions) if (browser.connected && (id === active.screenBotId || this.browserSessionScreens.get(id) === active.screenBotId)) {
      try { const binding = await browser.loginBinding(site); if (!matches.some(match => match.binding.pageId === binding.pageId)) matches.push({browser, binding}); else await browser.releaseLoginBinding(binding); } catch { /* Other tab lease or no eligible login. */ }
    }
    if (matches.length !== 1) { await Promise.all(matches.map(match => match.browser.releaseLoginBinding(match.binding))); throw new Error("Open one unambiguous login page for this site before requesting a saved credential"); }
    return matches[0]!;
  }
  private async automaticLogin(active: ActiveTurn, browser: BrowserUseSession): Promise<boolean> {
    const site = await browser.currentLoginSite(); if (!site) return false;
    let binding: Awaited<ReturnType<BrowserUseSession["loginBinding"]>> | undefined;
    try {
      binding = await browser.loginBinding(site);
      const values = await this.nativeToolExecutor.desktopCapability("AutomaticSavedCredential", active.screenBotId, {site});
      if (values.skipped || typeof values.password !== "string") return false;
      this.rememberBrowserValues(active.screenBotId, [values.password, values.username]);
      const bound = binding;
      return await this.screens.withAgentBrowserInput(active.screenBotId, active.cwd, async signal => { signal?.throwIfAborted(); return browser.fillSavedLogin(bound, values as {origin:string;password:string;username?:string}); });
    } catch { return false; } finally { if (binding) await browser.releaseLoginBinding(binding); }
  }

  private async privateBrowser(active: ActiveTurn): Promise<BrowserUseSession> {
    await this.screens.browserEndpointForAgent(active.screenBotId, active.cwd);
    await this.formBrowser(active.screenBotId);
    const browser = [...this.browserUseSessions.entries()].find(([id, session]) => session.connected && (id === active.screenBotId || this.browserSessionScreens.get(id) === active.screenBotId))?.[1];
    if (!browser) throw new Error("The bot browser is unavailable");
    return browser;
  }

  private async desktopTool(active: ActiveTurn, name: string, args: unknown, signal?: AbortSignal, callId?: string): Promise<AgentToolResult<Record<string, unknown>>> {
    const output = await this.nativeToolExecutor.desktopCapability(name, active.botId, args, signal, callId);
    if (name === "request_cookie_origin_approval" && output.kind === "collected") {
      signal?.throwIfAborted();
      let injected = 0, failed = output.cookies.length;
      try {
        const browser = await this.privateBrowser(active);
        this.rememberBrowserValues(active.screenBotId, output.cookies.map((cookie: any) => cookie.value));
        const result = await this.screens.withAgentBrowserInput(active.screenBotId, active.cwd, async leaseSignal => { signal?.throwIfAborted(); leaseSignal?.throwIfAborted(); return browser.importPrivateCookies(output.cookies); });
        injected = result.injected; failed = result.failed;
      } catch { signal?.throwIfAborted(); }
      const outcome = {...output,kind:failed ? "failed" : "completed",stage:"inject",errorClass:"CookieInjectionFailed",injected,failed,decision:output.decision ?? "approve_once"};
      return {content:[{type:"text",text:formatCookieOriginApprovalOutcome(outcome)}],details:{imported:injected,failed}};
    }
    if (name === "FetchIMessageAttachment") {
      if (typeof output.bytesBase64 !== "string" || typeof output.filename !== "string") throw new Error("Invalid attachment response");
      const bytes = Buffer.from(output.bytesBase64, "base64"); if (bytes.length > 100 * 1024 * 1024) throw new Error("Attachment exceeds 100 MiB");
      const path = join(active.cwd, "downloads", "messages", `${crypto.randomUUID()}-${basename(output.filename).replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      await agentFileIO("write", path, signal, bytes);
      const content: AgentToolResult<Record<string, unknown>>["content"] = [{ type: "text", text: ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(output.mime) ? `${output.filename} (${output.mime})` : `${output.filename} (${output.mime}) is on your box at ${path}. Open it with Read.` }];
      if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(output.mime)) {
        const image = await boundToolImage(bytes, output.mime); content.push(image);
      }
      return { content, details: { path, sizeBytes: bytes.length } };
    }
    return { content: [{ type: "text", text: renderDesktopResult(name, output, args as Record<string, any>) }], details: {} };
  }

  private async privateControl(active: ActiveTurn, callId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    const response = await fetch(`${this.serverUrl}/api/v0/internal/tools/call`, {
      method: "POST", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: active.runId, botId: active.botId, conversationId: active.conversationId,
        channelId: active.channelId, deliveryId: active.deliveryId, callId, tool, arguments: args }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000),
    });
    if (!response.ok) { const body = await response.json().catch(() => ({})) as any; throw new Error(body.error?.message ?? `Private transfer service failed (${response.status})`); }
    return response.json() as Promise<Record<string, any>>;
  }

  private async transferPath(active: ActiveTurn, path: string, write: boolean): Promise<string> {
    const roots = [await realpath(this.workspaceRoot), await realpath(active.cwd)];
    const target = resolve(path);
    if (!roots.some(root => target.startsWith(root + sep))) throw new Error("File transfer path must be inside the workspace or this bot's directory");
    let existing = write ? dirname(target) : target;
    for (;;) { try { existing = await realpath(existing); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !write) throw error; const parent=dirname(existing); if(parent===existing)throw error;existing=parent; } }
    if (!roots.some(root => existing === root || existing.startsWith(root + sep))) throw new Error("File transfer symlink escapes the allowed directory");
    return target;
  }

  private async connectorTransfer(active: ActiveTurn, callId: string, tool: string, input: Record<string, any>, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
    let file: Awaited<ReturnType<typeof spoolFile>> | undefined;
    if (tool === "upload_file") {
      const source=agentReadStream(await this.transferPath(active,input.sourcePath,false),signal);
      try {file=await spoolFile(source.stream,{signal});await source.done;}
      catch(error){await file?.cleanup();throw error;} finally {source.cancel();}
    }
    try {
    const staged = {tool,input,...(file ? {sha256:file.sha256,sizeBytes:file.sizeBytes} : {})};
    const prepared = await this.privateControl(active, callId, "PrepareConnectorTransfer", staged, signal);
    if (prepared.outcome) return {content:[{type:"text",text:(tool==="upload_file" ? describeUploadFileOutcome : describeDownloadFileOutcome)(prepared.outcome,input)!}],details:{}};
    if (tool === "upload_file" && prepared.status === "completed") return { content: [{ type: "text", text: describeUploadFileOutcome({ kind: "uploaded", ...prepared.result }, input)! }], details: { ...prepared.result } };
    let reviewed = false;
    if (prepared.decision === "prompt") {
      const decision = await this.requestHostApproval(active, callId, new HostApprovalRequiredError({ gate: "auto-review", requestMethod: "openteam/autoReview", details: {
        type: "autoReview", gate: "auto-review", action: "mcp", toolName: tool, summary: `${tool === "upload_file" ? "Upload to" : "Download from"} ${prepared.connectionName}`,
        reason: "This connected account requires approval for file transfers", arguments: { ...input, connection: prepared.connectionId, sha256: staged.sha256, sizeBytes: staged.sizeBytes }, supportsAlwaysAllow: false,
      } }), signal);
      if (decision !== "accept") throw new Error("File transfer declined. Do not retry unless asked.");
      reviewed = true;
    }
    const envelope={runId:active.runId,botId:active.botId,conversationId:active.conversationId,channelId:active.channelId,deliveryId:active.deliveryId,callId,tool:"ExecuteConnectorTransfer",arguments:{...staged,input:{...input,connection:prepared.connectionId},reviewed}};
    const response=await fetch(`${this.serverUrl}/api/v0/internal/connector-transfer`,{method:"POST",headers:{authorization:`Bearer ${this.controlToken}`,"content-type":"application/octet-stream","x-openteam-transfer":Buffer.from(JSON.stringify(envelope)).toString("base64url")},body:file ? Bun.file(file.path) : undefined,signal});
    if(!response.ok){const failure=await response.json().catch(()=>({})) as any;throw new Error(failure.error?.message ?? `Transfer failed (${response.status}); inspect the destination before retrying`);}
    let output:Record<string,any>;
    if (tool === "download_file") {
      try {
      output=JSON.parse(Buffer.from(response.headers.get("x-openteam-transfer-result") ?? "","base64url").toString());
      const filename=basename(String(output.name)).replace(/[\\/\0]/g,"_");
      const path=await this.transferPath(active,input.destination.path ?? join(active.cwd,"downloads",[".",".."].includes(filename) ? "download" : filename),true);
      if(!response.body)throw new Error("File service returned no download stream");
      output.sizeBytes=await agentWriteStream(path,response.body,signal);output.boxPath=path;
      } catch(error) {await response.body?.cancel().catch(()=>{});throw error;}
    } else output=await response.json() as Record<string,any>;
    return { content: [{ type: "text", text: tool === "upload_file" ? describeUploadFileOutcome({ kind: "uploaded", ...output }, input)! : describeDownloadFileOutcome({ kind: "downloaded", ...output }, input)! }], details: { ...output } };
    } finally {await file?.cleanup();}
  }

  private async callControlPlaneTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(["Task", "SendFeedback", "InstallPlugin", "UninstallPlugin", "AddMcpServer", "UninstallMcpServer", "AuthenticateMcpServer", "RestartMcpServers", "RemoveMcpAccount", "RenameMcpAccount", "SetMcpInstructions"].includes(tool) ? 24 * 60 * 60_000 : ["SendToUser", "ReviewedExternalFileDelivery"].includes(tool) ? 5 * 60_000 : ["request_user_form", "DraftExternalMessage"].includes(tool) ? 120_000 : 30_000);
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
      const failure=(body as {error?:{code?:string;message?:string;details?:unknown}})?.error;
      if(tool==="SendToUser"&&failure?.code==="external_file_review_required") {
        const decision=await this.requestHostApproval(active,callId,new HostApprovalRequiredError({gate:"auto-review",requestMethod:"openteam/autoReview",details:{type:"autoReview",gate:"auto-review",action:"mcp",toolName:"SendToUser",summary:"Deliver these files to the connected channel",reason:failure.message??"Account policy requires review",arguments:failure.details,supportsAlwaysAllow:false}}),signal??AbortSignal.timeout(15*60_000));
        if(decision!=="accept")throw new Error("File delivery declined. Do not retry unless asked.");
        return this.callControlPlaneTool(active,callId,"ReviewedExternalFileDelivery",args,signal);
      }
      const message =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `OpenTeam tool host rejected the call (${response.status})`;
      throw new Error(message);
    }
    if (tool === "Task" && body && typeof body === "object" &&
      (body as Record<string, unknown>).foregroundPending === true) {
      return this.callControlPlaneTool(active, callId, tool, args, requestSignal);
    }
    if (body && typeof body === "object" && (body as any).completed && ["InstallPlugin","UninstallPlugin","AddMcpServer","UninstallMcpServer","AuthenticateMcpServer","RestartMcpServers","RemoveMcpAccount","RenameMcpAccount","SetMcpInstructions"].includes(tool)) {
      const fresh=await this.privateControl(active,`${callId}:catalog`,"RefreshToolCatalog",{},signal);
      active.pluginNamespaces=fresh.namespaces;
    }
    if (tool === "WakeParent" && body && typeof body === "object" &&
      (body as Record<string, unknown>).woken === true) active.endTurnRequested = true;
    if (
      ([SEND_TO_USER_TOOL.name, "ReviewedExternalFileDelivery", REQUEST_BOX_HELP_TOOL.name, "request_user_form", "DraftExternalMessage", "SendFeedback", "create_bot_share_json"].includes(tool)) &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).sent === true
    ) {
      active.sentMessageCount += 1;
      active.toolActivityAfterLastSend = false;
      const input = args as { end_turn?: boolean; type?: string };
      if (input.end_turn === true || input.type === "widget" || input.type === "secret-request" || [REQUEST_BOX_HELP_TOOL.name, "request_user_form", "SendFeedback"].includes(tool)) active.endTurnRequested = true;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: renderControlResult(tool, body, args as Record<string, any>),
        },
      ],
      details: { tool, ...(tool === "TodoWrite" && body && typeof body === "object" && "todos" in body ? {todos: body.todos} : {}) },
      ...(active.endTurnRequested ? { terminate: true } : {}),
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
      const body = (Array.isArray(result.details.todos) ? result.details : JSON.parse(text)) as { todos?: unknown };
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
    return dynamicCatalog(
      (...args) => this.callControlPlaneTool(...args),
      (turn, callId, args, signal) => this.executeTodoWrite(turn, callId, args, signal),
      (...args) => this.executeReviewedTask(...args),
      active,
      (turn, _callId, args, signal) => {
        const input = Schema.decodeUnknownSync(AwaitShellInput)(parseHostAwaitShellRequest(args));
        if (input.machineId) {
          if (turn.subagentType || turn.runtimeProfile === "subagent") {
            throw new Error("Subagents cannot target the user's local computer");
          }
          return this.nativeToolExecutor.externalAwaitShell(input, signal);
        }
        return this.nativeToolExecutor.awaitShell(input, signal, turn.botId);
      },
      [
        ...(active.runtimeProfile === "subagent" || active.requestSource === "automation" ? [] : CONNECTOR_TRANSFER_TOOLS.map((definition): RuntimeDynamicTool => ({
          ...definition, source: "first-party", decodeArguments: args => parseConnectorTransfer(definition.name, args),
          execute: (turn, callId, args, signal) => this.connectorTransfer(turn, callId, definition.name, args as Record<string, any>, signal),
        }))),
        ...(active.runtimeProfile === "subagent" || active.requestSource === "automation" ? [] : DESKTOP_CAPABILITY_TOOLS.map((definition): RuntimeDynamicTool => ({
          ...definition, source: "first-party", decodeArguments: args => parseReferenceArguments(definition.name, args),
          execute: (turn, callId, args, signal) => this.desktopTool(turn, definition.name, args, signal, callId),
        }))),
        ...(active.runtimeProfile === "subagent" ? [] : ["DraftExternalMessage", "SendFeedback", "create_bot_share_json"].map((name): RuntimeDynamicTool => {
          const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
          return { name, description: definition.description, inputSchema: definition.inputSchema, source: "first-party", decodeArguments: name === "DraftExternalMessage" ? parseExternalDraft : (input) => input,
            execute: (turn, callId, args, signal) => this.callControlPlaneTool(turn, callId, name, args, signal) };
        })),
        ...(active.runtimeProfile === "subagent" ? [] : ["request_user_form", "remap_user_form_targets"].map((name): RuntimeDynamicTool => {
          const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
          return { name, description: definition.description, inputSchema: definition.inputSchema, source: "first-party",
            decodeArguments: name === "request_user_form" ? parseUserForm : (args) => ({ targets: parseFormRemap(args) }),
            execute: async (turn, callId, args, signal) => {
              if (name === "request_user_form") return this.callControlPlaneTool(turn, callId, name, args, signal);
              const receipt = await this.userForms.remap(turn.botId, args, callId).catch(error => {
                if (error instanceof Error && error.message === "No held form fields remain for this bot") return null;
                throw error;
              });
              if (!receipt) return {content:[{type:"text",text:buildUserFormRemapReceipt({kind:"no_hold"})}],details:{}};
              if (receipt.unknownFieldIds) return {content:[{type:"text",text:buildUserFormRemapReceipt({kind:"unknown_fields",unknownFieldIds:receipt.unknownFieldIds,heldFieldIds:receipt.heldFieldIds})}],details:{}};
              const recorded = await this.callControlPlaneTool(turn, callId, "RecordUserFormRemap", receipt, signal);
              await this.userForms.acknowledgeRemap(turn.botId, receipt.formId);
              const text = recorded.content.find((part) => part.type === "text");
              const cardOutcome = text?.type === "text" ? JSON.parse(text.text) : undefined;
              const selected = new Set((args as any).targets.map((target: any) => target.fieldId));
              const output = receipt.interrupted ? formatUserFormReceipt(receipt) : buildUserFormRemapReceipt({kind:"remapped",fillFailureKinds:receipt.fillFailureKinds,domainMismatch:receipt.domainMismatch,outcomes:receipt.fields.filter(field=>selected.has(field.id)).map(field=>({id:field.id,filled:field.status==="filled"})),notRemappedFieldIds:receipt.fields.filter(field=>!selected.has(field.id)).map(field=>field.id)});
              return { content: [{ type: "text", text: output }], details: { formReceipt: receipt, cardOutcome } };
            },
          };
        })),
        ...["WebFetch", "WebSearch"].map((name): RuntimeDynamicTool => {
          const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
          return { name, description: definition.description, inputSchema: definition.inputSchema, source: "first-party",
            decodeArguments: (args) => {
              const key = name === "WebFetch" ? "url" : "search_term";
              const value = (args as Record<string, unknown>)?.[key];
              if (typeof value !== "string" || !value.trim() || value.length > 16_000) throw new Error(`${key} must be a nonempty string of at most 16000 characters`);
              return value.trim();
            },
            execute: (turn, _callId, args, signal) => name === "WebFetch"
              ? this.webTools.fetch(args as string, turn.cwd, signal)
              : this.webTools.search(args as string, signal),
          };
        }),
        ...(active.runtimeProfile === "subagent" ? [] : ["CopyToBox", "CopyFromBox"].map((name): RuntimeDynamicTool => {
        const definition = CURSOR_TOOLS.find((tool) => tool.tool === name)!;
        return {
          name, description: definition.description, inputSchema: definition.inputSchema, source: "first-party",
          decodeArguments: (args) => {
            const value = args as Record<string, unknown>;
            const required = name === "CopyToBox" ? "computer_path" : "box_path";
            if (!value || typeof value[required] !== "string" || !String(value[required]).trim() || typeof value.machineId !== "string" || !value.machineId.trim()) throw new Error(`${required} and machineId are required`);
            for (const key of ["computer_path", "box_path"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !String(value[key]).trim())) throw new Error(`${key} must be a nonempty path`);
            return { machineId: value.machineId, ...(value.box_path ? { box_path: String(value.box_path).trim() } : {}), ...(value.computer_path ? { computer_path: String(value.computer_path).trim() } : {}) };
          },
          execute: (turn, callId, args, signal) => this.executeHostTool(turn, callId, name, signal, (approvals) =>
            this.nativeToolExecutor.copyFile(name === "CopyToBox" ? "toBox" : "fromBox", args as Parameters<NativeToolExecutor["copyFile"]>[1], turn.cwd, signal, approvals)),
        };
      }))]
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
    const form = result.namespaces.flatMap(namespace => namespace.tools).find(tool => tool.name === "request_user_form");
    if (form && input.namespace && !input.pattern) {
      const keys = await this.userForms.savedExtraKeys();
      form.description += "\n\nVault extras: reuse the exact saved extra_key for the same nonsecret fact across forms; never put a value in the key.\n" +
        (keys.length ? "Saved extra keys:\n" + keys.map(key => `- ${JSON.stringify(key)}`).join("\n") : "No saved extra keys yet.");
    }
    const text = JSON.stringify(renderDynamicDiscovery(result, input), null, 2);
    if (!input.toolName && Buffer.byteLength(text) > 12_000) {
      const outputPath = join(active.cwd, ".openteam", "dynamic-tools", `${crypto.randomUUID()}.json`);
      await agentFileIO("write", outputPath, undefined, Buffer.from(text));
      return { content: [{type:"text",text:describeOutputLocation({filePath:outputPath,sizeBytes:Buffer.byteLength(text),lineCount:text.split("\n").length}, {})}], details: {namespaceCount:result.namespaces.length,outputPath} };
    }
    return { content: [{type:"text",text}], details: {namespaceCount:result.namespaces.length} };
  }

  private async callDynamicTool(
    active: ActiveTurn,
    callId: string,
    input: CallDynamicToolInput,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (active.readOnly && (input.namespace !== "cursor" || !["WebSearch", "WebFetch", "SearchPlugins", "GetPlugin", "GetMcpServerStatus", "ListAgents", "ListGroups"].includes(input.toolName))) throw new Error("This tool is unavailable to a read-only plugin agent");
    const resolved = resolveDynamicTool(
      this.dynamicCatalog(active),
      active.discoveredDynamicTools,
      input
    );
    const invoke = () => {
      signal?.throwIfAborted();
      if (active.endTurnRequested) throw new Error("The turn has ended; wait for the next user message");
      return resolved.tool.execute(active, callId, resolved.arguments, signal, input.mcpDetails);
    };
    if (input.namespace === "cursor" && ["AwaitShell", "WebFetch", "WebSearch", "ListAgents", "ListGroups", "CheckSubagent", "SearchPlugins", "GetPlugin", "GetMcpServerStatus"].includes(input.toolName)) return invoke();
    const previous = this.mutationTails.get(active.contextSessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(invoke);
    this.mutationTails.set(active.contextSessionId, result);
    try { return await result; } finally { if (this.mutationTails.get(active.contextSessionId) === result) this.mutationTails.delete(active.contextSessionId); }
  }
}
