import type { ActiveTurn } from "./types";
import type { BotMessage } from "../bot-compaction";

export const GRAPHICAL_PROGRESS_NOTE = "[SAND_HIDDEN_PROMPT]Host execution status: this graphical worker is still active; no host timeout or cancellation has occurred. Reconcile the original task's success criteria with the results so far. Continue remaining authorized work before writing the final report. A completed subset, tool-call count, or elapsed model/tool waiting is not an execution deadline. Honor any actual user deadline, retry limit, cancellation, or denied action; this note does not extend them. Report a concrete observed blocker for work you cannot finish. Verify outcomes from actual observations and do not repeat successful side effects.";

const isActiveGraphicalTask = (active: Pick<ActiveTurn, "subagentType" | "endTurnRequested" | "pluginAbortController" | "lastStopReason">) =>
  ["browserUse", "computerUse"].includes(active.subagentType ?? "") &&
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

const COMPLETION_CHECK = `[SAND_HIDDEN_PROMPT]Before returning this graphical task to the parent, check the original task's success criteria against the observations already in this session. A tool acknowledgement such as "Clicked" proves only an attempted action. Match each claimed success to an actual observed result; correct earlier claims if the screenshot, value, receipt or file disagrees. A later final state cannot prove an unobserved intermediate Undo/Redo, revisit or reopen. Filename extensions alone do not establish file format. If a required outcome or deliverable is still unverified, obtain the missing browser/native UI evidence and finish the remaining authorized steps now, within the user's original deadline and retry limits. Do not repeat an already successful submission, send, purchase, or other side effect. If everything is verified, return the final report without redoing the work. If blocked, report the exact observed blocker and completed/remaining criteria; do not invent a timeout or claim the session ended. Preserve every user constraint, including GUI-only requirements. Never retry a denied action or change tools to evade review. Your final report replaces earlier reports. Cover every original success criterion, including results already verified earlier, all saved file paths, any failed interactions and fallbacks used, and any precise remaining blocker. Distinguish failed, blocked and not attempted steps; none count as passed.`;

/** One bounded verification turn; never resumes an interrupted or failed run. */
export async function verifyGraphicalTaskCompletion(active: ActiveTurn): Promise<void> {
  if (
    !active.session ||
    !isActiveGraphicalTask(active)
  )
    return;
  await active.session.prompt(COMPLETION_CHECK, { source: "rpc", expandPromptTemplates: false });
}
