import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalDecision,
  CALL_DYNAMIC_TOOL_TOOL,
  CallDynamicToolInput,
  COMPUTER_USE_TOOL,
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
import type { ActiveTurn, RuntimeDynamicTool } from "./types";

export const OPENTEAM_DYNAMIC_DISCOVERY_DESCRIPTION =
  "Discover and inspect tools available through OpenTeam dynamic namespaces. Search by namespace, exact tool name, or bounded regular-expression pattern. Catalog searches abbreviate long descriptions; exact lookups return complete public schemas. Always discover a tool before calling it with CallDynamicTool. The cursor namespace contains OpenTeam's supported TodoWrite, bounded agent and group directory lookup, plugin lifecycle management, subagent orchestration, agent administration, and channel administration subset.";

export const OPENTEAM_DYNAMIC_CALL_DESCRIPTION =
  "Invoke one previously discovered tool from an authorized OpenTeam dynamic namespace. The gateway rechecks availability, validates nested arguments against the current schema, and reauthorizes the call at execution time.";

export const GRAPHICAL_WORKER_SHELL_DESCRIPTION =
  "Executes a command in this worker's box with an optional foreground timeout. Use Shell for terminal operations and bulk file processing; use Read for reading, searching, or inspecting files. Run independent commands in parallel and chain dependent commands with &&. If shell text search is necessary, use rg rather than grep or find.";

export const GRAPHICAL_WORKER_READ_DESCRIPTION =
  "Reads a file on the box, the same filesystem Shell acts on. Text files include line numbers and support offset/limit paging. Image files are returned inline, and PDF files are converted to text.";

export const HOST_ROUTING_DESCRIPTION =
  "By default this operates in the agent's isolated box. To target a user's connected computer, first call ListMachines and pass its exact machineId. Local-computer access is permission-gated and the requested command or file is shown to the user.";

export const SUBAGENT_PRIVATE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
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
    this.nativeToolExecutor = new NativeToolExecutor({ agentDir, controlToken });
  }
  private readonly nativeToolExecutor: NativeToolExecutor;

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
        executionMode: "sequential" as const,
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
          : `OpenTeam tool host rejected the call (${response.status})`;
      throw new Error(message);
    }
    if (
      (tool === SEND_TO_USER_TOOL.name || tool === REQUEST_BOX_HELP_TOOL.name) &&
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
    return dynamicCatalog(
      (...args) => this.callControlPlaneTool(...args),
      (...args) => this.executeTodoWrite(...args),
      (...args) => this.executeReviewedTask(...args),
      active
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
    return resolved.tool.execute(active, callId, resolved.arguments, signal);
  }
}
