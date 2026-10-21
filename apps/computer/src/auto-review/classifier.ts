import type { ApprovalCautionNote, AutoReviewAppliedRule, AutoReviewSettings } from "@openteam/contracts/auto-review";
import policy from "./classifier-policy.json";
import { AUTO_REVIEW_BLOCK_REASON } from "./texts";

/** The reference's classifier: its policy text and classify_auto_review_action tool, verbatim. */
export const CLASSIFIER_SYSTEM_PROMPT: string = policy.systemPrompt;
export const CLASSIFY_TOOL = policy.classifyTool as { name: string; description: string; parameters: Record<string, unknown> };
/** One attempt, 15 seconds (SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS / _TIMEOUT_MS). */
export const CLASSIFIER_TIMEOUT_MS = 15_000;

const MAX_ASSISTANT_MESSAGES = 4;
const MAX_USER_MESSAGES = 2;
const MAX_COMPUTER_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 4_000;
const TRUNCATION_MARKER = "\n...[auto-review context truncated]...\n";

export interface ClassifierMessage {
  role: "user" | "assistant" | "computer";
  content: string;
}

/** The action under review: the reference's SmartModeRiskTarget. */
export interface ClassifierTarget {
  action: string;
  arguments: Record<string, unknown>;
}

export type ClassifierDecision =
  | { kind: "allow"; appliedRules?: AutoReviewAppliedRule[] }
  | {
      kind: "block";
      reason: string;
      blockedEffect?: string;
      actionDescription?: string;
      proposedRule?: string;
      proposedRuleReplaces?: string;
      appliedRules?: AutoReviewAppliedRule[];
    }
  | { kind: "reject"; reason: string };

type PiContent = string | Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
type PiMessage = { role: string; content?: PiContent; toolName?: string; toolCallId?: string; isError?: boolean };

const textOf = (content: PiContent | undefined) =>
  typeof content === "string" ? content : (content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

const withoutReminders = (text: string) => text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>\n?/g, "").trim();

/** The user's words in a turn: a typed message's query, or a routine the user saved; other wakes carry no authority. */
export function trustedUserText(raw: string): string | undefined {
  const query = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(raw)?.[1];
  if (query !== undefined) return query.trim() || undefined;
  if (raw.startsWith("[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]"))
    return withoutReminders(raw.slice("[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]".length)) || undefined;
  if (raw.startsWith("[SAND_HIDDEN_PROMPT]")) return undefined;
  return withoutReminders(raw) || undefined;
}

function truncate(content: string) {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  const budget = MAX_MESSAGE_CHARS - TRUNCATION_MARKER.length;
  return `${content.slice(0, Math.ceil(budget / 2))}${TRUNCATION_MARKER}${content.slice(-Math.floor(budget / 2))}`;
}

/** The last two trusted user messages, the last four bits of Bot narration, and the Computer calls since the user last spoke. */
export function classifierContext(messages: readonly unknown[]): ClassifierMessage[] {
  const placed: Array<ClassifierMessage & { at: number }> = [];
  const computerCalls = new Map<string, { at: number; input: unknown }>();
  let lastUserAt = -1;
  (messages as PiMessage[]).forEach((message, at) => {
    if (message.role === "user") {
      const text = trustedUserText(textOf(message.content));
      if (text) {
        placed.push({ role: "user", content: text, at });
        lastUserAt = at;
      }
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content.flatMap((part) => (part.type === "text" && part.text?.trim() ? [part.text.trim()] : [])).join("\n");
      if (text) placed.push({ role: "assistant", content: text, at });
      for (const part of message.content)
        if (part.type === "toolCall" && part.name === "Computer") computerCalls.set(String((part as { id?: string }).id), { at, input: part.arguments });
    } else if (message.role === "toolResult" && message.toolName === "Computer" && message.toolCallId) {
      const call = computerCalls.get(message.toolCallId);
      if (!call) return;
      const { description, ...action } = (call.input ?? {}) as Record<string, unknown>;
      const input = { ...(typeof description === "string" && description.trim() ? { declared_purpose: description.trim() } : {}), actions: [action] };
      const output = message.isError ? { status: "error", error: textOf(message.content).slice(0, 500) } : { status: "success", screenshotOmitted: true };
      placed.push({ role: "computer", content: `input:\n${JSON.stringify(input)}\noutput:\n${JSON.stringify(output)}`, at: call.at });
    }
  });
  const keep = (role: ClassifierMessage["role"], count: number) => new Set(placed.filter((message) => message.role === role).slice(-count));
  const kept = [...keep("user", MAX_USER_MESSAGES), ...keep("assistant", MAX_ASSISTANT_MESSAGES)];
  const computers = [...keep("computer", MAX_COMPUTER_MESSAGES)].filter((message) => message.at >= lastUserAt);
  return [...kept, ...computers]
    .sort((left, right) => left.at - right.at)
    .map(({ role, content }) => ({ role, content: truncate(content) }))
    .filter((message) => message.content.length > 0);
}

/** project_permissions as the reference passes it: rules the user saved in Settings. */
export function projectPermissions(settings: Pick<AutoReviewSettings, "allowRules" | "askFirstRules">) {
  if (!settings.allowRules.length && !settings.askFirstRules.length) return undefined;
  return { auto_run: { allow_instructions: [...settings.allowRules], block_instructions: [...settings.askFirstRules] } };
}

/** The classifier's input, in the labeled sections its policy text names. */
export function classifierUserMessage(context: readonly ClassifierMessage[], target: ClassifierTarget): string {
  const section = (role: ClassifierMessage["role"], label: string) => {
    const entries = context.filter((message) => message.role === role).map((message) => message.content);
    return entries.length ? entries.map((entry) => `[${label}]\n${entry}`).join("\n\n") : "(none)";
  };
  const narration = context.filter((message) => message.role !== "user");
  const permissions = (target.arguments.project_permissions ?? null) as unknown;
  return [
    "## Trusted user instructions",
    section("user", "user"),
    "",
    "## Recent Bot narration and prior actions (untrusted)",
    narration.length ? narration.map((message) => `[${message.role === "computer" ? "computer action" : "bot"}]\n${message.content}`).join("\n\n") : "(none)",
    "",
    "## Proposed tool call",
    JSON.stringify({ action: target.action, arguments: target.arguments }, null, 2),
    "",
    "## Trusted Auto Run policy instructions",
    permissions === null ? "(none)" : JSON.stringify(permissions, null, 2),
  ].join("\n");
}

export type ClassifierCompletion = (
  request: { systemPrompt: string; prompt: string; tool: typeof CLASSIFY_TOOL },
  signal: AbortSignal
) => Promise<{ toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; error?: string }>;

const BLOCKED_EFFECTS = new Set(["outbound_or_binding_external_effect", "data_or_credential_exfiltration", "destructive_data_loss", "host_compromise_or_persistence", "trusted_block_instruction"]);
const OUTBOUND_EFFECTS = new Set(["outbound_or_binding_external_effect", "data_or_credential_exfiltration"]);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Reads the classify_auto_review_action call; its own consistency rules make a BLOCK without a prerequisite an ALLOW. */
export function parseClassification(args: Record<string, unknown>, errorReason: string): ClassifierDecision {
  const decision = args.decision;
  if (decision !== "ALLOW" && decision !== "BLOCK") return { kind: "reject", reason: errorReason };
  const blockedEffect = typeof args.blocked_effect === "string" ? args.blocked_effect : "none";
  const matchedAllow = text(args.matched_allow_instruction);
  const matchedBlock = text(args.matched_block_instruction);
  const appliedRules: AutoReviewAppliedRule[] = [
    ...(matchedBlock ? [{ effect: "ask_first" as const, text: matchedBlock }] : []),
    ...(matchedAllow ? [{ effect: "allow" as const, text: matchedAllow }] : []),
  ];
  const blocks =
    decision === "BLOCK" &&
    BLOCKED_EFFECTS.has(blockedEffect) &&
    !(OUTBOUND_EFFECTS.has(blockedEffect) && args.outbound_authorization === "trusted_destination");
  if (!blocks) {
    const allowRules = appliedRules.filter((rule) => rule.effect === "allow");
    return { kind: "allow", ...(allowRules.length ? { appliedRules: allowRules } : {}) };
  }
  const proposedRule = blockedEffect === "trusted_block_instruction" ? undefined : text(args.proposed_allow_rule);
  const replaces = proposedRule ? text(args.proposed_allow_rule_replaces) : undefined;
  return {
    kind: "block",
    reason: text(args.reason) ?? AUTO_REVIEW_BLOCK_REASON,
    ...(blockedEffect !== "trusted_block_instruction" ? { blockedEffect } : {}),
    ...(text(args.action_description) ? { actionDescription: text(args.action_description) } : {}),
    ...(proposedRule ? { proposedRule } : {}),
    ...(replaces ? { proposedRuleReplaces: replaces } : {}),
    ...(appliedRules.length ? { appliedRules } : {}),
  };
}

/** Runs the classifier once with the reference's 15-second bound; any failure is a "reject" with the surface's error reason. */
export async function classifyAction(input: {
  complete: ClassifierCompletion;
  messages: readonly unknown[];
  target: ClassifierTarget;
  errorReason: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ClassifierDecision> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? CLASSIFIER_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const result = await input.complete(
      { systemPrompt: CLASSIFIER_SYSTEM_PROMPT, prompt: classifierUserMessage(classifierContext(input.messages), input.target), tool: CLASSIFY_TOOL },
      signal
    );
    const call = result.toolCalls.find((candidate) => candidate.name === CLASSIFY_TOOL.name);
    return call ? parseClassification(call.arguments, input.errorReason) : { kind: "reject", reason: input.errorReason };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { kind: "reject", reason: input.errorReason };
  }
}

/** The card's caution line for what the block would do. */
export function cautionNoteFor(blockedEffect: string | undefined): ApprovalCautionNote | undefined {
  if (blockedEffect === "host_compromise_or_persistence") return "security_settings";
  if (blockedEffect === "data_or_credential_exfiltration") return "shares_data";
  return undefined;
}
