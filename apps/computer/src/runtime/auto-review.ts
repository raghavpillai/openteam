import { createHash } from "node:crypto";
import type { ApprovalRequest, AutoReviewSettings } from "@openteam/contracts/auto-review";
import type { ComputerUseInput, ShellToolInput } from "@openteam/contracts";
import { describeTrigger } from "@openteam/contracts/reference-main-parsers";
import {
  classifyAction,
  cautionNoteFor,
  projectPermissions,
  type ClassifierCompletion,
  type ClassifierDecision,
  type ClassifierTarget,
} from "../auto-review/classifier";
import {
  computerCardTarget,
  describeMcpAction,
  describeShellAction,
  mcpRawRequest,
  summarizeBrowserAction,
  summarizeComputerAction,
  summarizeMcpAction,
  summarizeRoutineWrite,
  type BrowserExactAction,
  type ComputerExactAction,
} from "../auto-review/summaries";
import {
  APPROVAL_EXPIRED,
  APPROVAL_INTERRUPTED,
  AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON,
  BROWSER_ELEMENT_REQUIRED,
  CLASSIFIER_MANUAL_REVIEW_ERROR_REASON,
  COMPUTER_ACTION_CANCELLED,
  COMPUTER_CLASSIFIER_ERROR_REASON,
  COMPUTER_DESCRIPTION_REQUIRED,
  mcpBlockedText,
  PENDING_APPROVAL_REASON,
  SEQUENCE_TOO_LONG_FOR_CARD_REASON,
  shellBlockedText,
  USER_DECLINED,
} from "../auto-review/texts";
import type { ActiveTurn } from "./types";

/** The turn's Auto-review state: the user's settings, and the bot whose cards share the one-at-a-time limit. */
export interface TurnAutoReview extends AutoReviewSettings {
  scopeBotId: string;
}

type Control = (active: ActiveTurn, callId: string, tool: string, args: unknown, signal?: AbortSignal) => Promise<Record<string, any>>;
export type ApprovalOutcome = { approved: true } | { approved: false; reason: string };

/** A refused action: the tool returns this text to the model and nothing ran. */
export class AutoReviewRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoReviewRefusal";
  }
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const BYPASS_COMPUTER_ACTIONS = new Set(["screenshot", "move", "wait", "scroll"]);
/** Browser tools that only look: snapshot, screenshot, hover, find, console and waits. */
const BROWSER_OPS: Record<string, string | null> = {
  browser_click: "click",
  browser_drag: "drag",
  browser_type: "type",
  browser_fill_form: "fill",
  browser_select_option: "select_option",
  browser_press_key: "press_key",
  browser_navigate: "navigate",
  browser_navigate_back: "navigate_back",
  browser_tabs: "tabs",
  browser_run_code: "run_code",
  browser_file_upload: "file_upload",
  browser_handle_dialog: "handle_dialog",
  browser_snapshot: null,
  browser_take_screenshot: null,
  browser_hover: null,
  browser_find: null,
  browser_console_messages: null,
  browser_wait_for: null,
};
const MAX_CARD_INPUTS = 10;

/** Auto-review in the runtime: classify a risky action, refuse it on a block, and hold it on an approval card when asked. */
export class AutoReviewGate {
  private readonly pending = new Map<string, number>();
  /** Actions the user already denied in this conversation; a repeat is blocked with the same reason. */
  private readonly refusals = new Map<string, Map<string, string>>();

  constructor(private readonly control: Control) {}

  enabled(active: ActiveTurn): boolean {
    return active.autoReview?.enabled === true && active.autoReviewComplete !== undefined;
  }

  private scope(active: ActiveTurn) {
    return active.autoReview?.scopeBotId ?? active.botId;
  }

  /** While a card waits for the user, no other side effect starts. */
  assertNoPending(active: ActiveTurn) {
    if ((this.pending.get(this.scope(active)) ?? 0) > 0) throw new AutoReviewRefusal(PENDING_APPROVAL_REASON);
  }

  private priorRefusal(active: ActiveTurn, key: string) {
    return this.refusals.get(active.contextSessionId)?.get(key);
  }

  private async classify(active: ActiveTurn, key: string, target: ClassifierTarget, errorReason: string, signal?: AbortSignal): Promise<ClassifierDecision> {
    const recorded = this.priorRefusal(active, key);
    if (recorded !== undefined) return { kind: "block", reason: recorded };
    const settings = active.autoReview!;
    const permissions = projectPermissions(settings);
    return classifyAction({
      complete: active.autoReviewComplete!,
      messages: active.compactionReadPiMessages?.() ?? (active.session?.messages as unknown[] | undefined) ?? [],
      target: { ...target, arguments: { ...target.arguments, ...(permissions ? { project_permissions: permissions } : {}) } },
      errorReason,
      signal,
    });
  }

  /** Shows the card and holds the action until the user answers, the card expires, or the turn stops. */
  async requestApproval(active: ActiveTurn, callId: string, request: Omit<ApprovalRequest, "expiryPolicy">, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const scope = this.scope(active);
    this.pending.set(scope, (this.pending.get(scope) ?? 0) + 1);
    let approvalId: string | undefined;
    try {
      const expiryPolicy = active.requestSource === "turn" || active.requestSource === "handoff-resume" ? "park" : "ttl";
      let result = await this.control(active, `${callId}:approval`, "RequestApproval", { ...request, expiryPolicy }, signal);
      if (result.status === "busy") return { approved: false, reason: PENDING_APPROVAL_REASON };
      approvalId = String(result.approvalId);
      while (result.status === "pending") {
        signal?.throwIfAborted();
        result = await this.control(active, `${callId}:approval-wait`, "AwaitApproval", { approvalId }, signal);
      }
      approvalId = undefined;
      if (result.status === "approved" || result.status === "always") {
        if (typeof result.savedRule === "string" && active.autoReview && !active.autoReview.allowRules.includes(result.savedRule))
          active.autoReview.allowRules = [...active.autoReview.allowRules, result.savedRule];
        return { approved: true };
      }
      if (result.status === "denied") {
        const refusals = this.refusals.get(active.contextSessionId) ?? new Map<string, string>();
        refusals.set(request.fingerprint, request.reason);
        this.refusals.set(active.contextSessionId, refusals);
        return { approved: false, reason: USER_DECLINED };
      }
      return { approved: false, reason: result.retired === "ttl" ? APPROVAL_EXPIRED : APPROVAL_INTERRUPTED };
    } finally {
      const left = (this.pending.get(scope) ?? 1) - 1;
      if (left > 0) this.pending.set(scope, left);
      else this.pending.delete(scope);
      if (approvalId !== undefined)
        void this.control(active, `${callId}:approval-cancel`, "CancelApproval", { approvalId }).catch(() => undefined);
    }
  }

  private cardFields(decision: Extract<ClassifierDecision, { kind: "block" }>) {
    const cautionNote = cautionNoteFor(decision.blockedEffect);
    return {
      reason: decision.reason,
      ...(decision.actionDescription ? { actionDescription: decision.actionDescription } : {}),
      ...(decision.proposedRule ? { proposedRule: decision.proposedRule } : {}),
      ...(decision.proposedRule && decision.proposedRuleReplaces ? { proposedRuleReplaces: decision.proposedRuleReplaces } : {}),
      ...(decision.appliedRules ? { appliedRules: decision.appliedRules } : {}),
      ...(cautionNote ? { cautionNote } : {}),
    };
  }

  /** Shell: a block returns to the model; the same call retried with request_smart_mode_approval shows the card. */
  async reviewShell(active: ActiveTurn, callId: string, input: ShellToolInput, cwd: string, signal?: AbortSignal) {
    if (!this.enabled(active)) return;
    this.assertNoPending(active);
    const surface = input.machineId ? ("host_shell" as const) : ("box_shell" as const);
    const workingDirectory = input.working_directory ?? (input.machineId ? undefined : cwd);
    const key = fingerprint({ surface, command: input.command, workingDirectory: workingDirectory ?? null, machineId: input.machineId ?? null, background: input.block_until_ms === 0 });
    const decision = await this.classify(active, key, {
      action: "shell",
      arguments: {
        command: input.command,
        ...(workingDirectory ? { working_directory: workingDirectory } : {}),
        shell: "bash",
        execution_surface: input.machineId ? "host_machine" : "isolated_box",
        ...(input.description ? { description: input.description } : {}),
        background: { requested: input.block_until_ms === 0, start_in_background: input.block_until_ms === 0 },
        timeout: { ...(input.block_until_ms !== undefined ? { requested_block_until_ms: input.block_until_ms } : {}), timeout_behavior: "background" },
        permissions: { requested_permissions: [], sandbox_enabled: false, is_readonly: active.readOnly === true },
      },
    }, CLASSIFIER_MANUAL_REVIEW_ERROR_REASON, signal);
    if (decision.kind === "allow") return this.assertNoPending(active);
    if (decision.kind === "reject") throw new AutoReviewRefusal(`Rejected: ${decision.reason}`);
    if (input.request_smart_mode_approval !== true) throw new AutoReviewRefusal(shellBlockedText(decision.reason));
    const described = describeShellAction({ surface, command: input.command, workingDirectory, description: input.description });
    const outcome = await this.requestApproval(active, callId, {
      surface,
      fingerprint: key,
      ...described,
      ...this.cardFields(decision),
      command: input.command.slice(0, 4_000),
    }, signal);
    if (!outcome.approved) throw new AutoReviewRefusal(`Rejected: ${outcome.reason}`);
  }

  /** An external MCP call through CallDynamicTool. */
  async reviewMcp(
    active: ActiveTurn,
    callId: string,
    call: {
      namespace: string;
      serverDisplayName: string;
      toolName: string;
      arguments: Record<string, unknown>;
      toolDescription: string;
      inputSchema: unknown;
      readOnlyHint?: boolean;
      details?: { description?: string; requestSmartModeApproval?: boolean; smartModeBlockReason?: string };
    },
    signal?: AbortSignal
  ) {
    if (!this.enabled(active)) return;
    this.assertNoPending(active);
    const schemaText = JSON.stringify(call.inputSchema ?? null);
    const definitionHash = createHash("sha256")
      .update(JSON.stringify({ description: call.toolDescription, inputSchema: call.inputSchema ?? null, annotations: call.readOnlyHint === undefined ? null : { readOnlyHint: call.readOnlyHint } }))
      .digest("hex");
    const key = fingerprint({ server: call.namespace, toolName: call.toolName, arguments: call.arguments, definitionHash });
    const decision = await this.classify(active, key, {
      action: "mcp",
      arguments: {
        server: { identifier: call.namespace, name: call.namespace, display_name: call.serverDisplayName },
        tool_name: call.toolName,
        mcp_mode: "call",
        arguments: call.arguments,
        tool_definition: {
          description: call.toolDescription.slice(0, 4_000),
          input_schema_json: schemaText.slice(0, 12_000),
          ...(call.readOnlyHint === undefined ? {} : { annotations: { readOnlyHint: call.readOnlyHint } }),
          definition_hash: definitionHash,
          truncated: call.toolDescription.length > 4_000 || schemaText.length > 12_000,
        },
      },
    }, CLASSIFIER_MANUAL_REVIEW_ERROR_REASON, signal);
    if (decision.kind === "allow") return this.assertNoPending(active);
    if (decision.kind === "reject") throw new AutoReviewRefusal(decision.reason);
    if (call.details?.requestSmartModeApproval !== true) throw new AutoReviewRefusal(mcpBlockedText(decision.reason));
    const target = { serverDisplayName: call.serverDisplayName, toolName: call.toolName, mcpArguments: call.arguments };
    const outcome = await this.requestApproval(active, callId, {
      surface: "mcp",
      fingerprint: key,
      ...describeMcpAction({ ...target, description: call.details.description, readOnlyHint: call.readOnlyHint, blockedEffect: decision.blockedEffect }),
      ...this.cardFields(decision),
      command: summarizeMcpAction(target),
      fullRequest: mcpRawRequest(target),
    }, signal);
    if (!outcome.approved) throw new AutoReviewRefusal(outcome.reason);
  }

  /** Mutating Computer inputs; a block raises the card on its own. */
  async reviewComputer(active: ActiveTurn, callId: string, input: ComputerUseInput, signal?: AbortSignal) {
    if (!this.enabled(active)) return;
    const { then = [], description: rawDescription, ...first } = input;
    const actions = [first, ...then] as Array<ComputerExactAction & Record<string, unknown>>;
    const mutating = actions.filter((action) => !BYPASS_COMPUTER_ACTIONS.has(action.action));
    if (!mutating.length) return;
    this.assertNoPending(active);
    const description = rawDescription?.trim() || undefined;
    if (!description && mutating.some((action) => action.action === "click" || action.action === "drag"))
      throw new AutoReviewRefusal(COMPUTER_DESCRIPTION_REQUIRED);
    const inputs = mutating.map((action) => ({
      action_kind: action.action,
      ...(action.x !== undefined && action.y !== undefined ? { coordinates: { x: action.x, y: action.y } } : {}),
      ...(action.x2 !== undefined && action.y2 !== undefined ? { end_coordinates: { x: action.x2, y: action.y2 } } : {}),
      ...Object.fromEntries(["path", "button", "count", "modifiers", "text", "key", "holdDurationMs"].flatMap((field) => (action[field] === undefined ? [] : [[field === "holdDurationMs" ? "hold_duration_ms" : field, action[field]]]))),
    }));
    const key = fingerprint({ actions: mutating, description: description ?? "", box_id: active.screenBotId });
    const decision = await this.classify(active, key, {
      action: "sand_computer",
      arguments: {
        surface: "computer",
        ...(inputs.length === 1 ? inputs[0] : { action_kind: "sequence", inputs }),
        ...(description ? { declared_purpose: description } : {}),
        box: { box_id: active.screenBotId },
      },
    }, COMPUTER_CLASSIFIER_ERROR_REASON, signal);
    if (decision.kind === "allow") return this.assertNoPending(active);
    if (decision.kind === "reject") throw new AutoReviewRefusal(decision.reason);
    if (mutating.length > MAX_CARD_INPUTS) throw new AutoReviewRefusal(SEQUENCE_TOO_LONG_FOR_CARD_REASON);
    const outcome = await this.requestApproval(active, callId, {
      surface: "computer",
      fingerprint: key,
      summary: mutating.length === 1 ? summarizeComputerAction(mutating[0]!, description) : computerCardTarget(mutating),
      ...this.cardFields(decision),
      fullRequest: JSON.stringify({ actions: mutating, purpose: description }, null, 2),
    }, signal);
    if (signal?.aborted) throw new AutoReviewRefusal(COMPUTER_ACTION_CANCELLED);
    if (!outcome.approved) throw new AutoReviewRefusal(outcome.reason);
  }

  /** Mutating browser tools; looking (snapshots, screenshots, hovers, finds, waits) passes untouched. */
  async reviewBrowser(active: ActiveTurn, callId: string, toolName: string, args: Record<string, any>, targetPageUrl: string | undefined, signal?: AbortSignal) {
    if (!this.enabled(active)) return;
    const op = BROWSER_OPS[toolName];
    if (!op) return;
    if (op === "tabs" && !(args.action === "new" && typeof args.url === "string" && args.url)) return;
    this.assertNoPending(active);
    const element = typeof (args.element ?? args.startElement) === "string" ? String(args.element ?? args.startElement).trim() || undefined : undefined;
    if ((op === "click" || op === "drag") && !element) throw new AutoReviewRefusal(BROWSER_ELEMENT_REQUIRED);
    const fields = Array.isArray(args.fields) ? (args.fields as Array<Record<string, unknown>>) : [];
    const exact: BrowserExactAction = {
      op,
      ...(typeof args.url === "string" ? { url: args.url } : {}),
      ...(typeof args.text === "string" ? { text: args.text } : {}),
      ...(op === "fill" ? { value: fields.map((field) => String(field.value ?? "")).join(", ") } : {}),
      ...(Array.isArray(args.values) ? { values: args.values.map(String) } : {}),
      ...(typeof args.key === "string" ? { key: args.key } : {}),
      ...(typeof args.code === "string" ? { code: args.code } : {}),
      ...(op === "tabs" ? { tabsAction: String(args.action) } : {}),
      ...(typeof args.index === "number" ? { tabIndex: args.index } : {}),
      ...(element ? { element } : {}),
    };
    const key = fingerprint({ toolName, args, box_id: active.screenBotId, targetPageUrl: targetPageUrl ?? null });
    const decision = await this.classify(active, key, {
      action: "sand_computer",
      arguments: {
        surface: "browser",
        action_kind: `browser_${op}`,
        ...(targetPageUrl ? { target_page_url: targetPageUrl } : {}),
        ...(exact.url ? { url: exact.url } : {}),
        ...(exact.text !== undefined ? { text: exact.text } : {}),
        ...(op === "fill" ? { fields } : {}),
        ...(exact.values ? { values: exact.values } : {}),
        ...(exact.key ? { key: exact.key } : {}),
        ...(exact.code ? { code: exact.code } : {}),
        ...(exact.tabsAction ? { tabs_action: exact.tabsAction } : {}),
        ...(Array.isArray(args.paths) ? { paths: args.paths } : {}),
        ...(typeof args.accept === "boolean" ? { accept: args.accept } : {}),
        ...(args.submit === true ? { submit: true } : {}),
        ...(element ? { declared_purpose: element } : {}),
        box: { box_id: active.screenBotId },
      },
    }, COMPUTER_CLASSIFIER_ERROR_REASON, signal);
    if (decision.kind === "allow") return this.assertNoPending(active);
    if (decision.kind === "reject") throw new AutoReviewRefusal(decision.reason);
    const outcome = await this.requestApproval(active, callId, {
      surface: "computer",
      fingerprint: key,
      summary: summarizeBrowserAction({ ...exact, ...(targetPageUrl ? { targetPageUrl } : {}) }),
      ...this.cardFields(decision),
      fullRequest: JSON.stringify({ tool: toolName, arguments: args, ...(targetPageUrl ? { pageUrl: targetPageUrl } : {}) }, null, 2),
    }, signal);
    if (!outcome.approved) throw new AutoReviewRefusal(outcome.reason);
  }

  /** Saving or changing a routine; a card only when the classifier blocks. Returns the refusal, if any. */
  async reviewRoutineWrite(active: ActiveTurn, callId: string, args: Record<string, any>, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.enabled(active) || (args.action !== "create" && args.action !== "update")) return undefined;
    let current: Record<string, any> = {};
    if (args.action === "update" && typeof args.id === "string") {
      const read: Record<string, any> = await this.control(active, `${callId}:review-read`, "UpdateRoutine", { action: "get", id: args.id }, signal).catch(() => ({}));
      if (typeof read.refused !== "string") current = read;
    }
    const trigger = args.trigger ?? (typeof args.schedule === "string" ? { type: "cron", schedule: args.schedule } : undefined) ?? current.trigger ?? (current.schedule ? { type: "cron", schedule: current.schedule } : undefined);
    const spec = {
      name: String(args.name ?? current.name ?? ""),
      prompt: String(args.prompt ?? current.prompt ?? ""),
      trigger,
      isEnabled: typeof args.enabled === "boolean" ? args.enabled : current.enabled ?? true,
    };
    let triggerDescription = "";
    try {
      triggerDescription = trigger ? describeTrigger(trigger) : "";
    } catch {
      triggerDescription = typeof args.schedule === "string" ? args.schedule : "";
    }
    const key = fingerprint({ operation: args.action, id: args.id ?? null, spec });
    const decision = await this.classify(active, key, {
      action: "sand_automation_write",
      arguments: {
        surface: "automation_write",
        operation: args.action,
        write_provenance: active.requestSource === "turn" || active.requestSource === "handoff-resume" ? "user" : "untrusted",
        ...(args.id ? { automation_id: args.id } : {}),
        name: spec.name,
        prompt: spec.prompt,
        ...(trigger ? { trigger } : {}),
        ...(trigger?.type === "cron" ? { schedule: trigger.schedule } : {}),
        trigger_description: triggerDescription,
        enabled: spec.isEnabled,
        referenced_workflows: [],
        referencing_routines: [],
      },
    }, AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON, signal);
    if (decision.kind === "allow") return undefined;
    if (decision.kind === "reject") return decision.reason;
    const outcome = await this.requestApproval(active, callId, {
      surface: "automation_write",
      fingerprint: key,
      summary: summarizeRoutineWrite({ operation: args.action, name: spec.name, triggerDescription, prompt: spec.prompt, isEnabled: spec.isEnabled }),
      ...this.cardFields(decision),
      fullRequest: spec.prompt,
    }, signal);
    return outcome.approved ? undefined : outcome.reason;
  }

  /** Runtime-only state for a context that ended. */
  forget(contextSessionId: string) {
    this.refusals.delete(contextSessionId);
  }
}

const REQUEST_SMART_MODE_APPROVAL_DESCRIPTION =
  "Set to true when immediately retrying the exact same command after Auto-review blocks it and you decide the user should approve it through the native approval card.";
const SMART_MODE_BLOCK_REASON_DESCRIPTION =
  "Provide the exact block reason returned by Auto-review in the prior rejection. Required when request_smart_mode_approval is true so the approval card shows the original classifier reason without re-running the classifier.";
const MCP_REQUEST_SMART_MODE_APPROVAL_DESCRIPTION =
  "Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card.";
const MCP_SMART_MODE_BLOCK_REASON_DESCRIPTION =
  "Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier.";

/** Shell's request_smart_mode_approval and CallDynamicTool's mcpDetails approval fields, the reference's enforce-mode schema. */
export function withApprovalRetryParameters<T extends { name: string; inputSchema: unknown }>(tool: T): T {
  const schema = tool.inputSchema as { properties?: Record<string, any> };
  if (tool.name === "Shell")
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          request_smart_mode_approval: { type: "boolean", description: REQUEST_SMART_MODE_APPROVAL_DESCRIPTION },
          smart_mode_block_reason: { type: "string", description: SMART_MODE_BLOCK_REASON_DESCRIPTION },
        },
      },
    };
  const details = schema.properties?.mcpDetails;
  if (tool.name !== "CallDynamicTool" || !details) return tool;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        mcpDetails: {
          ...details,
          properties: {
            ...details.properties,
            requestSmartModeApproval: { type: "boolean", default: false, description: MCP_REQUEST_SMART_MODE_APPROVAL_DESCRIPTION },
            smartModeBlockReason: { type: "string", description: MCP_SMART_MODE_BLOCK_REASON_DESCRIPTION },
          },
        },
      },
    },
  };
}

/** A Pi model call that offers only the classify tool. */
export function classifierCompletion(
  complete: (request: { systemPrompt: string; messages: unknown[]; tools: unknown[] }, signal: AbortSignal) => Promise<{ content?: Array<Record<string, any>>; stopReason?: string; errorMessage?: string }>
): ClassifierCompletion {
  return async (request, signal) => {
    const result = await complete(
      {
        systemPrompt: request.systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
        tools: [{ name: request.tool.name, description: request.tool.description, parameters: request.tool.parameters }],
      },
      signal
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? "Classifier call failed");
    return {
      toolCalls: (result.content ?? []).flatMap((part) =>
        part.type === "toolCall" && typeof part.name === "string" ? [{ name: part.name, arguments: (part.arguments ?? {}) as Record<string, unknown> }] : []
      ),
    };
  };
}
