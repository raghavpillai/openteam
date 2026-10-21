import type { ActiveTurn } from "./types";
import type { BotMessage } from "../bot-compaction";

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
