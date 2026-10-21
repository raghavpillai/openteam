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
  if (name === "ReactToMessage" && typeof result.note === "string") return result.note;
  if (name === "ReactToMessage" && (result.reacted || result.removed))
    return `Reacted ${args.emoji.trim()} on ${args.message_address.trim()}. (Reactions toggle: react the same emoji again to take it back.)`;
  if (name === "DraftExternalMessage" && result.sent) {
    const where =
      args.platform === "email"
        ? `email from ${args.from} to ${[args.to ?? []].flat().join(", ")}`
        : `Slack message to ${result.target ?? args.target}`;
    const id = result.message_id ? ` (id: ${result.message_id})` : "";
    // The user's approval settings can send a card at once; the server says how that went.
    if (result.delivery === "sent") return `Sent the ${where}${id}. ${result.note}`;
    if (result.delivery === "unknown")
      return `The ${where} was sent without review, but delivery is unconfirmed${id}. ${result.note}`;
    const card = result.in_dm
      ? `is now an editable card in your own 1:1 chat with the user, not in this room (a room cannot hold draft cards); tell the room where it is${id}.`
      : `is now an editable card in the chat${id}.`;
    if (result.delivery === "pending") return `Draft ${where} ${card} ${result.note}`;
    return `Draft ${where} ${card} Nothing has been sent; the user reviews, may edit, and sends or discards it from the card.`;
  }
  if (name === "RequestUserForm" && result.sent)
    return "Showed the form to the user; your turn is over. When they submit, the host fills the browser and resumes you with a per-field receipt (fill statuses only, never the submitted values). If they dismiss it, you'll be resumed with that outcome. If they choose to do the step on the screen instead, the host hands them the box directly (same as request_box_help) and you'll be resumed when they hand it back."
      + (typeof result.preflightNote === "string" ? `\n\n${result.preflightNote}` : "");
  if (isStateTool(name)) {
    const labels: Record<string, string> = {
      name: "name",
      description: "description",
      title: "title",
      avatar_shape: "avatar shape",
      avatar_color: "avatar color",
    };
    const settingNames: Record<string, string> = {
      hidden_from_sidebar: "hiddenFromSidebar",
      notify_on_updates: "notifyOnAgentUpdates",
      drafting_disabled: "draftingDisabled",
    };
    const settingsText = () =>
      `Updated your settings: ${Object.keys(settingNames)
        .filter((key) => args[key] !== undefined)
        .map((key) => settingNames[key])
        .join(", ")}.`;
    // A refused state change or read is an ordinary result, not a tool failure.
    if (typeof result.refused === "string")
      return `${result.target === "routine" && args.action === "get" ? "Not read" : "Not saved"}: ${result.refused}`;
    // UpdateProfile saves its settings fields as a second update beside the profile.
    if (result.target === "profile" && result.updated)
      return [
        `Updated your ${Object.keys(labels)
          .filter((key) => args[key] !== undefined)
          .map((key) => labels[key])
          .join(", ")}.`,
        ...(result.settings?.updated ? [settingsText()] : []),
        ...(typeof result.settings?.refused === "string" ? [`Settings not saved: ${result.settings.refused}`] : []),
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
    if (result.target === "routine" && args.action === "get")
      return [
        `Routine "${result.name}" (folder ${result.folder}), ${result.enabled ? "enabled" : "paused"}.`,
        `Trigger: ${describeTrigger(result.trigger)}`,
        result.trigger?.type === "cron"
          ? `schedule: ${JSON.stringify(result.trigger.schedule)} (leave it out of an update unless the time itself changes)`
          : `trigger: ${JSON.stringify(result.trigger)}`,
        "Saved prompt:",
        result.prompt,
      ].join("\n");
    if (result.target === "routine") {
      // Resuming saves the routine again, so it reads like any other update.
      const verb = (
        {
          pause: "Paused",
          resume: "Updated",
          delete: "Deleted",
          create: "Saved",
          update: "Updated",
        } as Record<string, string>
      )[args.action];
      const owner = result.owner?.kind === "group" ? ` Owner: group "${result.owner.name ?? result.owner.id}" (${result.owner.id}).` : "";
      const summary = `${verb} routine "${result.name}" (folder ${result.folder ?? args.id})${["create", "update", "resume"].includes(args.action) ? `: ${describeTrigger(result.trigger ?? {type:"cron",schedule:result.schedule})}${result.enabled ? "" : ", paused"}` : ""}.${owner}`;
      const next = args.action === "delete" ? ""
        : typeof result.next_run_at === "string" ? `\nNext scheduled occurrence: ${localTime(result.next_run_at, result.timezone)}. Use this saved time if reporting the next run; do not calculate or guess a different time.`
        : result.next_run_at === null ? `\nNext scheduled occurrence: none${result.enabled === false ? " (paused)" : ""}.`
        : "";
      return `${summary}${next}${result.delivery_nudge ? "\nGive the user a concise summary of what this routine does and where its result goes." : ""}`;
    }
    if (result.target === "avatar" && result.cleared)
      return "Cleared your picture. It is back to the default.";
  }
  if (name === "CreateBotShareJson" && result.staged)
    return `Staged unpublished version ${result.version} of "${result.name}". It is not public until you confirm it.`;
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
    // The finished-todos cleanup reminder rides after the fenced result (todoCleanupReminder).
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
  if (name === "SendToUser" && result.delivery_failed)
    return `Message to ${result.channel} was not delivered${result.reason ? `: ${result.reason}` : "."}${result.reason && !/[.!?]$/.test(result.reason) ? "." : ""} Tell the user it did not go through.`;
  if (name === "SendToUser" && result.sent)
    return `${result.message_address || result.message_id
      ? `Message sent to user. (id: ${result.message_address ?? result.message_id})`
      : "Message sent to user."}${sendsLocalFileSnapshot(args) ? ` ${FILE_SNAPSHOT_NOTE}` : ""}`;
  if (name === "MessageSubagent" && result.delivered)
    return `Message delivered to subagent ${args.subagent_id}. It will interrupt what it's doing, take your message into account, and keep working. You'll be revived with its result when it finishes, so don't wait on it.`;
  if (name === "StopSubagent" && result.stopped_all) return renderStopAllSubagents(result);
  if (name === "StopSubagent" && result.stopped)
    return `Stopping subagent ${args.subagent_id}. It will be torn down and won't report back.`;
  if (name === "CheckSubagent") {
    const elapsed = (seconds: number) =>
      seconds < 90
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    // Only running subagents are listed, so the reference always says "running".
    const describe = (sub: any, detailed: boolean) => {
      const activity: string[] = sub.recent_activity ?? [];
      const lines = [
        `- ${sub.subagent_id} [${sub.subagent_type}] "${sub.title}": running for ${elapsed(sub.elapsed_seconds)}, ${sub.tool_call_count} tool call(s)`,
      ];
      if (detailed) {
        lines.push(activity.length ? "  Recent activity (oldest first):" : "  No tool activity recorded yet.");
        lines.push(...activity.map((entry) => `    ${entry}`));
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

// The reference adds that the Library lists only the latest copy per path; OpenTeam has no Library.
const FILE_SNAPSHOT_NOTE =
  "The user got a copy of the file as it is now. Later edits to the file do not reach them until you send it again; earlier copies stay in the chat unchanged.";
const PICTURE_OR_VIDEO = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|heic|heif|m4v|mov|mp4|ogv|webm)$/i;

/** A local file other than a picture or video is delivered as a copy of how it is now. */
function sendsLocalFileSnapshot(args: Record<string, any>): boolean {
  if (args.type !== "attachment" || typeof args.url !== "string" || !/^file:/i.test(args.url.trim())) return false;
  let path = args.url.trim();
  try {
    path = decodeURIComponent(new URL(path).pathname);
  } catch {}
  return !PICTURE_OR_VIDEO.test(path);
}

/** A saved time in the routine's zone, labeled with that zone. */
function localTime(iso: string, timeZone: unknown): string {
  const options = { timeZoneName: "short" } as const;
  try {
    return new Date(iso).toLocaleString("en-US", typeof timeZone === "string" && timeZone ? { ...options, timeZone } : options);
  } catch {
    return new Date(iso).toLocaleString("en-US", options);
  }
}

const SHELLS_NOT_COVERED = "Background shell commands you started yourself are not covered: terminate those with their reported PIDs.";

/** What happened to one peer this agent handed work to with a priority message. */
function describeDelegatedWork(peer: Record<string, any>): string {
  const label = `${peer.name} (agent ${peer.id})`;
  if (peer.result === "stopped") return `- ${label}: stop delivered; its turn is cancelled and its own subagents are being torn down.`;
  if (peer.result === "not_running") return `- ${label}: already idle, nothing to stop.`;
  return `- ${label}: stop failed${peer.detail ? ` (${peer.detail})` : ""}. Retry StopSubagent with all: true; if it fails again, tell the user it may still be working.`;
}

/** The stop-everything receipt: exactly which subagents stopped, had finished, or could not be stopped, and what happened to each peer. */
function renderStopAllSubagents(result: Record<string, any>): string {
  const listed = (entry: any) => `- ${entry.subagent_id} [${entry.subagent_type}] "${entry.title}"`;
  const stopped: any[] = result.stopped ?? [], finished: any[] = result.already_finished ?? [], failed: any[] = result.failed ?? [];
  const delegated: any[] = result.delegated ?? [];
  const total = stopped.length + finished.length + failed.length;
  if (total === 0 && delegated.length === 0)
    return "No background subagents are running and no work is out with other agents, so there was nothing to stop. Background shell commands you started yourself are not subagents: terminate those with their reported PIDs.";
  return [
    ...(total === 0 ? ["No background subagents of your own are running."] : []),
    ...(stopped.length ? [`Stopped ${stopped.length} of ${total} running subagent(s). They are torn down, will not report back, and anything they dispatched or ran inside their own turn ends with them:`, ...stopped.map(listed)] : []),
    ...(finished.length ? [`${finished.length} had already finished before the stop reached them (you are revived with a finished subagent's result separately):`, ...finished.map(listed)] : []),
    ...(failed.length ? [`${failed.length} could NOT be stopped and may still be running. Retry each with StopSubagent and its id; if it still fails, tell the user which work may still be running:`, ...failed.map((entry) => `${listed(entry)}: ${entry.error}`)] : []),
    ...(delegated.length
      ? [`Work you handed to other agents (${delegated.filter((peer) => peer.result === "stopped").length} of ${delegated.length} stopped):`, ...delegated.map(describeDelegatedWork)]
      : []),
    `Do not resume, redispatch, or continue the stopped work unless the user asks again. ${SHELLS_NOT_COVERED}`,
  ].join("\n");
}

/** Appended after a TodoWrite result, outside its data fence, when many finished todos remain. */
export const todoCleanupReminder = (todos: unknown): string | null =>
  Array.isArray(todos) && todos.filter((todo: any) => ["completed", "cancelled"].includes(todo?.status)).length > 20
    ? "<system_reminder>\nYou have many finished todos. Consider cleaning up old ones.\n</system_reminder>"
    : null;
