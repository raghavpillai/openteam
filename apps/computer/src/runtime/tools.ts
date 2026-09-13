import { HostShellCompletions } from "../host-shell-completions";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import {
  AwaitShellInput,
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { BROWSER_USE_TOOLS, BrowserUseSession } from "../browser/use";
import {
  discoverDynamicTools,
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
import { serverSearchConfiguration } from "../search-settings";
import { UserFormHost, type FormBrowser, type FormPageBinding } from "../user-form-host";
import type { ActiveTurn, RuntimeDynamicTool } from "./types";

export const OPENTEAM_DYNAMIC_DISCOVERY_DESCRIPTION =
  "Discover and inspect tools available through OpenTeam dynamic namespaces. Search by namespace, exact tool name, or bounded regular-expression pattern. Catalog searches abbreviate long descriptions; exact lookups return complete public schemas. Always discover a tool before calling it with CallDynamicTool. The cursor namespace includes shell waits, tasks, web search and fetch, host file transfers, reviewed forms and external messages, bot recipes, feedback, agent and group lookup, plugin management, subagents, and agent and channel administration. Availability reflects this deployment and the current agent's permissions.";

export const OPENTEAM_DYNAMIC_CALL_DESCRIPTION =
  "Invoke one previously discovered tool from an authorized OpenTeam dynamic namespace. The gateway rechecks availability, validates nested arguments against the current schema, and reauthorizes the call at execution time.";

export const GRAPHICAL_WORKER_SHELL_DESCRIPTION =
  "Executes a command in this worker's box with an optional foreground timeout. Use Shell for terminal operations and bulk file processing; use Read for reading, searching, or inspecting files. Run independent commands in parallel and chain dependent commands with &&. If shell text search is necessary, use rg rather than grep or find.";

export const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on. Text files include line numbers and support offset/limit paging. Image files are returned inline, and PDF files are converted to text.";

export const HOST_ROUTING_DESCRIPTION =
  "By default this operates in the agent's isolated box. To target a user's connected computer, first call ListMachines and pass its exact machineId. Local-computer access is permission-gated and the requested command or file is shown to the user.";

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
    this.webTools = new WebTools(new SearchProviderClient(serverSearchConfiguration(serverUrl, controlToken)));
    this.userForms = new UserFormHost(join(agentDir, "private-user-forms"), (botId) => this.formBrowser(botId));
    const deliverShellCompletion = async (completion: import("@openteam/contracts").ShellCompletionInput) => {
      if (!completion.scope) return;
      const response = await fetch(`${this.serverUrl}/api/v0/internal/shell-completions`, {
        method: "POST", headers: { authorization: `Bearer ${this.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify(completion), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Shell completion delivery failed (${response.status})`);
    };
    this.nativeToolExecutor = new NativeToolExecutor({ agentDir, controlToken, onShellComplete: deliverShellCompletion });
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
      const visibleDescription =
        !active.subagentType && (tool.name === SHELL_TOOL.name || tool.name === READ_TOOL.name)
          ? `${HOST_ROUTING_DESCRIPTION}\n\n${description}`
          : description;
      return defineTool({
        name: tool.name,
        label: tool.name,
        description:
          tool.name === GET_DYNAMIC_TOOLS_TOOL.name
            ? OPENTEAM_DYNAMIC_DISCOVERY_DESCRIPTION
            : tool.name === CALL_DYNAMIC_TOOL_TOOL.name
              ? OPENTEAM_DYNAMIC_CALL_DESCRIPTION
              : visibleDescription,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
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
        !LEGACY_EXTERNAL_NATIVE_TOOLS.has(tool.name) &&
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
    if (active.endTurnRequested) throw new Error("The turn has ended after delivery; wait for the next user message.");
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
            await this.hostShellCompletions.register({ botId: active.botId, channelId: active.channelId ?? undefined, machineId: shellInput.machineId!, shellId: result.details.shell_id, outputPath: result.details.output_path });
          }
          return result;
        });
      }
      const environment =
        active.subagentType === "computerUse"
          ? await this.screens.commandEnvironment(active.screenBotId, active.cwd)
          : undefined;
      return this.nativeToolExecutor.shell(
        shellInput,
        active.cwd,
        signal,
        environment,
        active.botId,
        { channelId: active.channelId }
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
            text: `Current OpenTeam screen (1280x800). Saved to ${path}`,
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
      this.browserSessionScreens.set(active.botId, active.screenBotId);
    }
    return browser.execute(toolName, args);
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

  private async callControlPlaneTool(
    active: ActiveTurn,
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(tool === "Task" ? 24 * 60 * 60_000 : ["request_user_form", "DraftExternalMessage"].includes(tool) ? 120_000 : 30_000);
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
          : `OpenTeam tool host rejected the call (${response.status})`;
      throw new Error(message);
    }
    if (
      ([SEND_TO_USER_TOOL.name, REQUEST_BOX_HELP_TOOL.name, "request_user_form", "DraftExternalMessage", "SendFeedback", "create_bot_share_json"].includes(tool)) &&
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
          text: typeof body === "string" ? body : JSON.stringify(body),
        },
      ],
      details: { tool },
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
              const receipt = await this.userForms.remap(turn.botId, args, callId);
              const recorded = await this.callControlPlaneTool(turn, callId, "RecordUserFormRemap", receipt, signal);
              await this.userForms.acknowledgeRemap(turn.botId, receipt.formId);
              const text = recorded.content.find((part) => part.type === "text");
              const cardOutcome = text?.type === "text" ? JSON.parse(text.text) : undefined;
              return { content: [{ type: "text", text: formatUserFormReceipt(receipt) }], details: { formReceipt: receipt, cardOutcome } };
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
    const invoke = () => {
      signal?.throwIfAborted();
      if (active.endTurnRequested) throw new Error("The turn has ended; wait for the next user message");
      return resolved.tool.execute(active, callId, resolved.arguments, signal, input.mcpDetails);
    };
    if (input.namespace === "cursor" && ["AwaitShell", "WebFetch", "WebSearch", "ListAgents", "ListGroups", "CheckSubagent", "SearchPlugins", "GetPlugin", "GetMcpServerStatus"].includes(input.toolName)) return invoke();
    const previous = this.mutationTails.get(active.botId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(invoke);
    this.mutationTails.set(active.botId, result);
    try { return await result; } finally { if (this.mutationTails.get(active.botId) === result) this.mutationTails.delete(active.botId); }
  }
}
