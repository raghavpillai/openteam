/** The reference's Auto-review result texts, quoted as captured (sand-auto-review* modules). */

export const BLOCKED_AUTONOMOUS_REMINDER_LEAD = "Auto-review blocked this autonomous";
const BLOCKED_AUTONOMOUS_PATHS =
  "Decide now between two paths: (1) if a genuinely safer, lower-privilege, authorized path satisfies the request, use it; (2) if this blocked action is still necessary and the user should approve it,";
const BLOCKED_AUTONOMOUS_COURIER =
  "Trying a different anonymous public file host, pastebin, disposable transfer link, or similar courier is NOT path (1) — that is the same unauthorized data-exposure crossing — so for that class prefer path (2) or ask the user, do not shop for another intermediary.";

/** The reminder appended to a block reason (the truthful-outcome variant is gated off in the reference). */
function blockedAutonomousReminder(toolCall: string, retry: string): string {
  return `\n\n<system_reminder>\n${BLOCKED_AUTONOMOUS_REMINDER_LEAD} ${toolCall}. ${BLOCKED_AUTONOMOUS_PATHS} immediately retry the exact same ${retry} ${BLOCKED_AUTONOMOUS_COURIER}\n</system_reminder>`;
}

export const SHELL_APPROVAL_RETRY =
  "Shell call with request_smart_mode_approval set to true AND smart_mode_block_reason set to the exact block reason text above. That retry is what shows the native approval card; stopping here leaves the user with no approval UI. Do not change the command, add permissions, or use an escalated variant when retrying for approval.";
export const DYNAMIC_MCP_APPROVAL_RETRY =
  "CallDynamicTool call with mcpDetails.requestSmartModeApproval set to true AND mcpDetails.smartModeBlockReason set to the exact block reason text above. Preserve mcpDetails.description from the blocked call. That retry is what shows the native approval card; stopping here leaves the user with no approval UI. Do not change the tool arguments or use an escalated variant when retrying for approval.";

/** A Shell block: ShellRejectedError shows the model "Rejected: <reason>". */
export const shellBlockedText = (reason: string) => `Rejected: ${reason}${blockedAutonomousReminder("tool call", SHELL_APPROVAL_RETRY)}`;
/** An MCP block through CallDynamicTool. */
export const mcpBlockedText = (reason: string) => `${reason}${blockedAutonomousReminder("MCP tool call", DYNAMIC_MCP_APPROVAL_RETRY)}`;

export const AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review";
export const SHELL_BLOCK_REASON = "Command blocked by Auto-review preflight";
/** "occured" is the reference's spelling. */
export const CLASSIFIER_MANUAL_REVIEW_ERROR_REASON = "An error occured while classifying this action. Please review manually.";
export const COMPUTER_CLASSIFIER_ERROR_REASON = "An error occurred while classifying this action. Please review manually.";
export const AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON = "An error occurred while reviewing this routine. Please review manually.";

export const WAIT_FOR_CARD =
  "This call did not run and has no approval card of its own. Don't retry it or start any other action while another action's approval card is still waiting for the user. If that card is still unanswered, end your turn now and ask the user to approve or deny it. Once it has been answered, retry this call if it is still needed.";
export const PENDING_APPROVAL_REASON = `Another action is waiting for Auto-review approval; no new side effect may start yet. ${WAIT_FOR_CARD}`;
export const TOO_MANY_PENDING_REASON = `Too many actions are already waiting for Auto-review approval. ${WAIT_FOR_CARD}`;

export const COMPUTER_DESCRIPTION_REQUIRED =
  "Computer click and drag actions require a concise description field stating the intended UI target and purpose.";
export const BROWSER_ELEMENT_REQUIRED =
  "Browser click and drag actions require an element field: a concise description of the intended target and purpose.";
export const SEQUENCE_TOO_LONG_FOR_CARD_REASON =
  "Auto-review blocked these inputs, and there are too many to list on one approval card. Retry them as smaller steps.";
export const COMPUTER_ACTION_CANCELLED = "The Computer action was cancelled.";

/** The reference's fallback when the card's answer carries no reason. */
export const USER_DECLINED = "The user declined.";
/** The reference host words expiry server-side; this follows its card ("No answer in time, so … didn't do this"). */
export const APPROVAL_EXPIRED = "No answer in time: the approval card expired before the user answered, so this did not run.";
/** The run stopped waiting (an interrupt or a restart): not a decision, so it can be raised again after resuming. */
export const APPROVAL_INTERRUPTED =
  "The approval card was interrupted before the user answered. That is not a decision; re-raise it after resuming if the action is still needed.";

export const FEEDBACK_NOT_APPROVED_MESSAGE =
  "Feedback was not sent: the user did not approve sending it. Do not retry; ask the user what they would like to do instead.";
export const FEEDBACK_APPROVAL_UNAVAILABLE_MESSAGE =
  "Feedback was not sent: sending feedback needs the user's approval, which is not available in this conversation. Tell the user to use Help > Send Feedback instead.";
/** Adapted: the deployment's support destination stands in for the reference's team. */
export const FEEDBACK_APPROVAL_REASON =
  "This exact text will be sent to the configured OpenTeam support destination from your account as product feedback. Nothing is sent unless you approve.";
export const FEEDBACK_APPROVAL_SUMMARY = "Send product feedback to the configured OpenTeam support destination";
