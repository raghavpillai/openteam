import type { ActiveTurn } from "./types";
import type { BotMessage } from "../bot-compaction";
import { textFromContent } from "./content";

export const GRAPHICAL_PROGRESS_NOTE = "[SAND_HIDDEN_PROMPT]Host execution status: this graphical worker is still active; no host timeout or cancellation has occurred. Reconcile the original task's success criteria with the results so far. Continue remaining authorized work before writing the final report. A completed subset, tool-call count, or elapsed model/tool waiting is not an execution deadline. Honor any actual user deadline, retry limit, cancellation, or denied action; this note does not extend them. Report a concrete observed blocker for work you cannot finish. Verify outcomes from actual observations and do not repeat successful side effects.";

const isActiveGraphicalTask = (active: Pick<ActiveTurn, "subagentType" | "endTurnRequested" | "pluginAbortController" | "lastStopReason">) =>
  active.subagentType === "computerUse" &&
  !active.endTurnRequested && !active.pluginAbortController?.signal.aborted &&
  !["aborted", "error"].includes(active.lastStopReason ?? "");

/** A durable checkpoint in the ordinary tool loop, never another model call.
 * Count only outcomes after the latest user task or checkpoint. */
export function graphicalProgressReminder(messages: readonly BotMessage[], active: ActiveTurn): string | null {
  if (!isActiveGraphicalTask(active) || messages.at(-1)?.role !== "toolResult") return null;
  let results = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.customType === "openteam-graphical-progress") break;
    if (message.role === "user" && !(message.providerOptions?.cursor as Record<string, unknown> | undefined)?.isUserInfo) break;
    if (message.role === "toolResult") results++;
  }
  return results >= 12 ? GRAPHICAL_PROGRESS_NOTE : null;
}

export const COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES = 20;
const REFUSED_OR_CANCELLED = /The turn has ended|Operation aborted|operation was aborted|AbortError/;

/** Refused and cancelled calls don't count; any success resets the streak. */
export function observeGraphicalToolResult(active: ActiveTurn, failed: boolean, text: string): void {
  if (active.subagentType !== "computerUse" || active.toolFailureBreakerTripped) return;
  if (!failed) {
    active.toolFailureStreak = [];
    return;
  }
  if (active.pluginAbortController?.signal.aborted || REFUSED_OR_CANCELLED.test(text)) return;
  (active.toolFailureStreak ??= []).push("tool_error");
  if (active.toolFailureStreak.length < COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES) return;
  active.toolFailureBreakerTripped = true;
  active.endTurnRequested = true;
}

const messageText = (message: BotMessage) =>
  typeof message.content === "string" ? message.content : textFromContent(message.content);
const isReminderOnly = (message: BotMessage) =>
  /^<system_reminder>[\s\S]*<\/system_reminder>$/.test(messageText(message).trim());

/** The helper's latest prose since its task message, or the summary that replaced it. */
export function latestHelperUpdate(messages: readonly BotMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "toolResult" || isReminderOnly(message)) continue;
    const summary = /<summary_content>([\s\S]*?)<\/summary_content>/.exec(
      message.role === "compactionSummary" ? String(message.summary ?? "") : messageText(message)
    )?.[1]?.trim();
    if (summary !== undefined) return summary;
    // Host notes are custom messages; only a real user message starts the task.
    if (message.role === "user") return undefined;
    if (message.role !== "assistant") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return undefined;
}

export function toolFailureReport(messages: readonly BotMessage[], streak: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const failure of [...streak].reverse()) counts.set(failure, (counts.get(failure) ?? 0) + 1);
  const update = latestHelperUpdate(messages);
  return [
    "Status: blocked",
    `The computer is unreachable: the last ${COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES} tool calls all failed with no success in between, so the helper stopped. Last errors: ${[...counts].map(([failure, count]) => `${failure} (${count})`).join(", ")}.`,
    ...(update === undefined ? [] : [`Its last update:\n\n${update}`]),
  ].join("\n\n");
}

const RAW_TOOL_CALL_MARKUP = /<tool_call>|<function=/;
const RAW_FUNCTION_NAME = /<function=([A-Za-z0-9_.-]{1,64})>/g;

/** A report that leaks tool-call markup did not do that step; say so instead of relaying the markup. */
export function blockedReportForRawToolCall(text: string): string | undefined {
  const markupAt = text.search(RAW_TOOL_CALL_MARKUP);
  if (markupAt < 0) return undefined;
  const tools = [...new Set([...text.matchAll(RAW_FUNCTION_NAME)].map((match) => match[1]))];
  const before = text.slice(0, markupAt).replace(/^Status:\s*\w+\s*$/im, "").trim();
  return [
    "Status: blocked",
    `I tried to call ${tools.length === 0 ? "a tool" : tools.join(", ")}, which I do not have here, so that step was not done.`,
    ...(before.length === 0 ? [] : [before]),
  ].join("\n\n");
}

/** The computerUse report the parent receives: the breaker's report, or the final text with leaked markup replaced. */
export function graphicalFinalReport(active: ActiveTurn, messages: readonly BotMessage[]): { id: string; text: string } | null {
  if (active.subagentType !== "computerUse" || active.pluginAbortController?.signal.aborted || active.lastStopReason === "aborted") return null;
  if (active.toolFailureBreakerTripped)
    return { id: `assistant:${active.runId}:tool-failures`, text: toolFailureReport(messages, active.toolFailureStreak ?? []) };
  const last = active.lastAgentMessage;
  const replaced = last ? blockedReportForRawToolCall(last.text) : undefined;
  return last && replaced ? { id: last.id, text: replaced } : null;
}
