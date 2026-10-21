import { describeTrigger } from "./reference-main-parsers";
import { isStateTool } from "./state-tools";
import { renderPluginResult } from "./plugin-tool-results";
import {
  formatChromeCookieImportOutcome,
  renderContactsResult,
  truncationNotice,
} from "./reference-formatters";

const SEND_TO_USER_FAILED = "Failed to send the message to the user";

/** The reference's SendToUser failure: the reason follows one fixed lead-in. */
export const sendToUserFailure = (detail: string): string => {
  const reason = detail.trim();
  if (reason.startsWith(SEND_TO_USER_FAILED)) return reason;
  return reason ? `${SEND_TO_USER_FAILED}: ${reason}` : `${SEND_TO_USER_FAILED}.`;
};

/** A failed tool call's reason: the tool host's error message rather than its JSON envelope. */
export const toolErrorDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const envelope = JSON.parse(message) as { message?: unknown } | null;
    if (envelope && typeof envelope.message === "string") return envelope.message;
  } catch {}
  return message;
};

/** Keep private transport receipts structured; format only at the model boundary. */
export function renderDesktopResult(
  name: string,
  output: Record<string, any>,
  args: Record<string, any>
): string {
  if (name === "RequestCookieOriginApproval") return formatChromeCookieImportOutcome(output);
  if (name === "FindContacts") return renderContactsResult(output);
  if (["ChatItems", "FindIMessageChats", "SearchIMessages"].includes(name)) {
    const notice = truncationNotice(output, name === "ChatItems" && args.chatGuid === undefined);
    return JSON.stringify(notice === undefined ? output : { ...output, notice });
  }
  return JSON.stringify(output);
}

export function renderControlResult(
  name: string,
  output: unknown,
  args: Record<string, any>
): string {
  if (typeof output === "string") return output;
  const result = output as Record<string, any>;
  const plugin = renderPluginResult(name, result, args);
  if (plugin !== undefined) return plugin;
  if (name === "ReactToMessage" && (result.reacted || result.removed))
    return `Reacted ${args.emoji.trim()} on ${args.message_address.trim()}. (Reactions toggle: react the same emoji again to take it back.)`;
  if (name === "DraftExternalMessage" && result.sent) {
    const where =
      args.platform === "email"
        ? `email to ${(args.to ?? []).join(", ")}`
        : `Slack message to ${result.target ?? args.target}`;
    const id = result.message_id ? ` (id: ${result.message_id})` : "";
    // The user's approval settings can send a card at once; the server says how that went.
    if (result.delivery === "sent") return `Sent the ${where}${id}. ${result.note}`;
    if (result.delivery === "unknown")
      return `The ${where} was sent without review, but delivery is unconfirmed${id}. ${result.note}`;
    if (result.delivery === "pending")
      return `Draft ${where} is now an editable card in the chat${id}. ${result.note}`;
    return `Draft ${where} is now an editable card in the chat${id}. Nothing has been sent; the user reviews, may edit, and sends or discards it from the card.`;
  }
  if (isStateTool(name)) {
    const labels: Record<string, string> = {
      name: "name",
      description: "description",
      title: "title",
      avatar_shape: "avatar shape",
      avatar_color: "avatar color",
    };
    const settingsText = () =>
      `Updated your settings: ${["hidden_from_sidebar", "notify_on_updates"]
        .filter((key) => args[key] !== undefined)
        .map((key) =>
          key === "hidden_from_sidebar" ? "hiddenFromSidebar" : "notifyOnAgentUpdates"
        )
        .join(", ")}.`;
    // UpdateProfile saves its settings fields as a second update beside the profile.
    if (result.target === "profile" && result.updated)
      return [
        `Updated your ${Object.keys(labels)
          .filter((key) => args[key] !== undefined)
          .map((key) => labels[key])
          .join(", ")}.`,
        ...(result.settings?.updated ? [settingsText()] : []),
        ...(typeof result.settings_error === "string" ? [`Settings not saved: ${result.settings_error}`] : []),
      ].join("\n");
    if (result.target === "settings" && result.updated) return settingsText();
    if (result.target === "skill")
      return result.deleted
        ? `Deleted skill ${result.id}.`
        : `${args.id ? "Updated" : "Saved"} skill "${result.name}" (id ${result.id}).`;
    if (result.target === "channel" && result.disconnected)
      return `Disconnected ${result.platform}. The connector closes the live connection within a few seconds.`;
    if (result.target === "avatar" && result.updated)
      return `Updated your picture (${result.resolved_path?.split("/").pop()}). Source ${result.path?.split("/").pop()} can be deleted if you no longer need it.`;
    if (result.target === "routine") {
      const verb = (
        {
          pause: "Paused",
          resume: "Resumed",
          delete: "Deleted",
          create: "Saved",
          update: "Updated",
        } as Record<string, string>
      )[args.action];
      const owner = result.owner?.kind === "group" ? ` Owner: group "${result.owner.name ?? result.owner.id}" (${result.owner.id}).` : "";
      const summary = `${verb} routine "${result.name}" (folder ${result.folder ?? args.id})${["create", "update"].includes(args.action) ? ` — ${describeTrigger(result.trigger ?? {type:"cron",schedule:result.schedule})}${result.enabled ? "" : ", paused"}` : ""}.${owner}`;
      if (typeof result.next_run_at === "string") return `${summary}\nNext scheduled occurrence: ${result.next_run_at}. Use this saved timestamp if reporting the next run; do not calculate or guess a different time.`;
      if (result.next_run_at === null) return `${summary}\nNext scheduled occurrence: none${result.enabled === false ? " (paused)" : ""}.`;
      return summary;
    }
    if (result.target === "avatar" && result.cleared)
      return "Cleared your picture — back to the default.";
  }
  if (name === "CreateBotShareJson" && result.published)
    return `Published bot template version ${result.version}. Verify the returned artifact before sharing it.`;
  if (name === "SendFeedback" && result.feedbackStatus) {
    if (result.feedbackStatus === "sent") return `Feedback sent to the configured OpenTeam support destination. They ${result.wantsResponse ? "asked for a reply" : "did not ask for a reply"}. Confirm to the user that it went through.`;
    return String(result.outcome ?? "Feedback could not be confirmed. Do not retry automatically.");
  }
  if (name === "TodoWrite" && Array.isArray(result.todos)) {
    let text =
      "Successfully updated TODOs. Make sure to follow and update your TODO list as you make progress. Cancel and add new TODO tasks as needed when the user makes a correction or follow-up request.";
    if (
      result.todos.some((t: any) => t.status === "pending") &&
      result.todos.every((t: any) => t.status !== "in_progress")
    )
      text += " No TODOs are marked in-progress, make sure to mark them before starting the next.";
    if (result.todos.filter((t: any) => ["completed", "cancelled"].includes(t.status)).length > 20)
      text +=
        "\n\n<system_reminder>You have many finished todos. Consider cleaning up old ones.</system_reminder>";
    return (
      text +
      "\n\nHere are the latest contents of your todo list:\n" +
      result.todos
        .map((t: any) => `- **${t.status.toUpperCase()}**: ${t.content} (id: ${t.id})`)
        .join("\n")
    );
  }
  if (name === "WakeParent" && result.woken)
    return "The parent was awakened and this automation turn has ended.";
  if (name === "SendToUser" && result.sent)
    if (result.queued) return `Message queued for the room when this turn completes. (id: ${result.message_address ?? result.message_id})`;
  if (name === "SendToUser" && result.silent) return "No room message delivered (silent turn).";
  if (name === "SendToUser" && result.sent)
    return result.message_address || result.message_id
      ? `Message sent to user. (id: ${result.message_address ?? result.message_id})`
      : "Message sent to user.";
  if (name === "MessageSubagent" && result.delivered)
    return `Message delivered to subagent ${args.subagent_id}. It will interrupt what it's doing, take your message into account, and keep working. You'll be revived with its result when it finishes — don't wait on it.`;
  if (name === "StopSubagent" && result.stopped_all) return renderStopAllSubagents(result);
  if (name === "StopSubagent" && result.stopped)
    return `Stopping subagent ${args.subagent_id}. It will be torn down and won't report back.`;
  if (name === "CheckSubagent") {
    const elapsed = (seconds: number) =>
      seconds < 90
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    const describe = (sub: any, detailed: boolean) => {
      const calls = sub.recent_tool_calls ?? [];
      const status = typeof sub.status === "string" ? sub.status : "status unavailable";
      const runStatus = typeof sub.run_status === "string" ? `; run: ${sub.run_status}` : "";
      const lines = [
        `- ${sub.subagent_id} [${sub.subagent_type}] "${sub.description}" — ${status}${runStatus}; elapsed ${elapsed(sub.elapsed_seconds)}, ${sub.tool_call_count ?? calls.length} tool call(s)`,
      ];
      if (detailed) {
        lines.push(
          calls.length ? "  Recent activity (oldest → newest):" : "  No tool activity recorded yet."
        );
        // Admission/start is not completion: preserve the persisted state so a
        // pending or failed call cannot read like a completed worker action.
        lines.push(...[...calls].reverse().map((call: any) => {
          const error = call.status === "failed" && typeof call.error === "string" && call.error
            ? ` — error: ${JSON.stringify(call.error.slice(0, 500))}` : "";
          return `    [${typeof call.status === "string" && call.status ? call.status : "status unavailable"}] ${call.tool}${error}`;
        }));
        if (sub.transcript_path)
          lines.push(
            `  Full transcript: call ReadTranscript with in=${sub.subagent_id} for the complete play-by-play.`
          );
      }
      return lines.join("\n");
    };
    if (result.subagents?.length === 0) return "No background subagents are running right now.";
    if (result.subagents)
      return [
        `${result.subagents.length} subagent(s) running:`,
        ...result.subagents.map((sub: any) => describe(sub, false)),
        "Pass a subagent_id to see its recent activity and transcript path.",
      ].join("\n");
    if (result.subagent_id) return describe(result, true);
  }
  return JSON.stringify(output);
}

const PEERS_NOT_STOPPED =
  "Peer agents you handed work to are not reached from here, so none of them was stopped. If any may still be working, message each with SendToAgent priority: true to stop, and tell the user what may still be running.";

/** The stop-everything receipt: exactly which subagents stopped, had finished, or could not be stopped. */
function renderStopAllSubagents(result: Record<string, any>): string {
  const listed = (entry: any) => `- ${entry.subagent_id} [${entry.subagent_type}] "${entry.description}"`;
  const stopped: any[] = result.stopped ?? [], finished: any[] = result.already_finished ?? [], failed: any[] = result.failed ?? [];
  const total = stopped.length + finished.length + failed.length;
  if (total === 0)
    return `No background subagents are running, so there was nothing of your own to stop. ${PEERS_NOT_STOPPED} Background shell commands you started yourself are not subagents: terminate those with their reported PIDs.`;
  return [
    ...(stopped.length ? [`Stopped ${stopped.length} of ${total} running subagent(s). They are torn down and will not report back:`, ...stopped.map(listed)] : []),
    ...(finished.length ? [`${finished.length} had already finished before the stop reached them (you are revived with a finished subagent's result separately):`, ...finished.map(listed)] : []),
    ...(failed.length ? [`${failed.length} could NOT be stopped and may still be running. Retry each with StopSubagent and its id; if it still fails, tell the user which work may still be running:`, ...failed.map((entry) => `${listed(entry)}: ${entry.error}`)] : []),
    PEERS_NOT_STOPPED,
    "Do not resume, redispatch, or continue the stopped work unless the user asks again. Background shell commands you started yourself are not covered: terminate those with their reported PIDs.",
  ].join("\n");
}
