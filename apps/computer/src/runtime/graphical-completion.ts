import type { ActiveTurn } from "./types";

const COMPLETION_CHECK = `[SAND_HIDDEN_PROMPT]Before returning this graphical task to the parent, check the original task's success criteria against the observations already in this session. A tool acknowledgement such as "Clicked" proves only an attempted action. If a required outcome or deliverable is still unverified, obtain the missing browser/native UI evidence and finish the remaining authorized steps now. Do not repeat an already successful submission, send, purchase, or other side effect. If everything is verified, return the final report without redoing the work. If blocked, report the exact observed blocker and completed/remaining criteria; do not invent a timeout or claim the session ended. Preserve every user constraint, including GUI-only requirements. Never retry a denied action or change tools to evade review. Your final report replaces earlier reports. Cover every original success criterion, including results already verified earlier, all saved file paths, any failed interactions and fallbacks used, and any precise remaining blocker.`;

/** One bounded verification turn; never resumes an interrupted or failed run. */
export async function verifyGraphicalTaskCompletion(active: ActiveTurn): Promise<void> {
  if (
    !active.session ||
    !["browserUse", "computerUse"].includes(active.subagentType ?? "") ||
    active.endTurnRequested ||
    active.pluginAbortController?.signal.aborted ||
    active.lastStopReason === "aborted" ||
    active.lastStopReason === "error"
  )
    return;
  await active.session.prompt(COMPLETION_CHECK, { source: "rpc", expandPromptTemplates: false });
}
