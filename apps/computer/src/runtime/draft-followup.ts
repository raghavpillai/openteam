import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ActiveTurn } from "./types";
import { textFromContent } from "./content";

export const DRAFT_FOLLOWUP_DELIVERY_REMINDER =
  "<system_reminder>\nThe platform already delivered the draft status, so the user does not need another acknowledgement. Your plain assistant text is internal and was not delivered. If you still owe the user a requested follow-up question, warning, error, or useful new information, actually invoke SendToUser with that information now. Do not leave a requested question as plain assistant text. If there is no new information or outstanding request, finish silently without repeating the draft status.\n</system_reminder>";

/** One conditional delivery check; a status-only event may still finish silently. */
export async function checkDraftFollowupDelivery(active: ActiveTurn, session: Pick<AgentSession, "messages" | "prompt">) {
  if (!active.draftStatusAcknowledged || active.requestSource !== "event" || active.sentMessageCount > 0 ||
      active.endTurnRequested || active.pluginAbortController?.signal.aborted ||
      ["aborted", "error"].includes(active.lastStopReason ?? "")) return;
  const final = session.messages.findLast(message => message.role === "assistant");
  if (!final || !textFromContent(final.content).trim()) return;
  await session.prompt(DRAFT_FOLLOWUP_DELIVERY_REMINDER, { source: "rpc", expandPromptTemplates: false });
}
