import type { ActiveTurn } from "./types";

const isActiveGraphicalTask = (active: Pick<ActiveTurn, "subagentType" | "endTurnRequested" | "pluginAbortController" | "lastStopReason">) =>
  active.subagentType === "computerUse" &&
  !active.endTurnRequested && !active.pluginAbortController?.signal.aborted &&
  !["aborted", "error"].includes(active.lastStopReason ?? "");

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
