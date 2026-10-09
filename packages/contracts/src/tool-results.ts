import { describeTrigger } from "./reference-main-parsers";
import { renderPluginResult } from "./plugin-tool-results";
import {
  formatChromeCookieImportOutcome,
  renderContactsResult,
  truncationNotice,
} from "./reference-formatters";

/** Keep private transport receipts structured; format only at the model boundary. */
export function renderDesktopResult(
  name: string,
  output: Record<string, any>,
  args: Record<string, any>
): string {
  if (name === "import_chrome_cookies") return formatChromeCookieImportOutcome(output);
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
    return `Draft ${where} is now an editable card in the chat${result.message_id ? ` (id: ${result.message_id})` : ""}. Nothing has been sent; the user reviews, may edit, and sends or discards it from the card.`;
  }
  if (name === "update_state") {
    const labels: Record<string, string> = {
      name: "name",
      description: "description",
      title: "title",
      avatar_shape: "avatar shape",
      avatar_color: "avatar color",
    };
    if (result.target === "profile" && result.updated)
      return `Updated your ${Object.keys(labels)
        .filter((key) => args[key] !== undefined)
        .map((key) => labels[key])
        .join(", ")}.`;
    if (result.target === "settings" && result.updated)
      return `Updated your settings: ${["hidden_from_sidebar", "notify_on_updates"]
        .filter((key) => args[key] !== undefined)
        .map((key) =>
          key === "hidden_from_sidebar" ? "hiddenFromSidebar" : "notifyOnAgentUpdates"
        )
        .join(", ")}.`;
    if (result.target === "skill")
      return result.deleted
        ? `Deleted skill ${result.id}.`
        : `${args.id ? "Updated" : "Saved"} skill "${result.name}" (id ${result.id}).`;
    if (result.target === "channel" && result.disconnected)
      return `Disconnected ${result.platform}. The connector closes the live connection within a few seconds.`;
    if (result.target === "project" && ["join", "leave"].includes(result.action))
      return `${result.action === "join" ? "Joined" : "Left"} project "${result.project}".`;
    if (result.target === "project" && result.action === "create")
      return result.created
        ? `Created and joined project "${result.name}" (folder ${result.project}).`
        : `Joined existing project "${result.project}" (create-is-join; project.md left as-is).`;
    if (result.target === "avatar" && result.updated)
      return `Updated your picture (${result.path?.split("/").pop()}). Source ${result.resolved_path?.split("/").pop()} can be deleted if you no longer need it.`;
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
  if (name === "create_bot_share_json" && result.published)
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
            `  Private transcript reference: ${sub.transcript_path}. Use cursor.ReadTranscript with this subagent_id for observable history; do not open the path with Read.`
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
