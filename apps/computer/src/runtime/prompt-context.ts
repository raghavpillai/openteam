import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import type { BotMessage } from "../bot-compaction";
import type { ActiveTurn } from "./types";
import { taskUserInfo, type TaskConfiguration } from "@openteam/contracts/task-configuration";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export function enrichUserInfo(
  base: string,
  input: {
    cwd: string;
    transcriptPath: string;
    namespaces: Array<{ name: string; description?: string; tools: Array<{ name: string }> }>;
    taskConfiguration?: TaskConfiguration;
    subagent?: boolean;
  }
): string {
  const environment = [
    `OS Version: ${platform()} ${release()}`,
    "Shell: /bin/bash",
    `Workspace Path: ${input.cwd}`,
    `Is directory a git repo: ${existsSync(join(input.cwd, ".git")) ? "Yes" : "Unknown (inspect the workspace if needed)"}`,
  ].join("\n");
  return [
    base.replace("<user_info>", `<user_info>\n${environment}`),
    `<agent_transcripts>\nPast conversation transcripts: ${input.transcriptPath}. Read relevant prior context when needed; do not cite internal transcript IDs to the user.\n</agent_transcripts>`,
    ...(input.subagent ? [] : [taskUserInfo(input.taskConfiguration)]),
    "<dynamic_tool_catalog>",
    "This catalog is a context snapshot. Use GetDynamicTools for current schemas and availability before calling CallDynamicTool.",
    ...input.namespaces.map(
      (entry) =>
        `${entry.name}: ${entry.description ?? ""}\nTools: ${entry.tools.map((tool) => tool.name).join(", ")}`
    ),
    "</dynamic_tool_catalog>",
  ].join("\n\n");
}

export function promptFingerprint(system: string, userInfo: string, tools: unknown, epoch: number) {
  return {
    systemSha: hash(system),
    userInfoSha: hash(userInfo),
    toolsSha: hash(tools),
    compactionEpoch: epoch,
  };
}

export const ACK_REMINDER =
  "<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user. Acknowledge them now by actually invoking SendToUser with a one-line text acknowledgement, then continue the work. Plain assistant text is not shown to the user; a widget or attachment does not count as this acknowledgement.\n</system_reminder>";
export const PROGRESS_REMINDER =
  "<system_reminder>\nYou have made several tool calls without a SendToUser, so the user is currently watching silence. Actually invoke the SendToUser tool now. Make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Send one brief update in a complete sentence, saying what you found or what happens next, not a play-by-play of each step, before continuing.\n</system_reminder>";
export const EARLY_RESULT_REMINDER =
  "<system_reminder>\nRemember: the user cannot see tool output or your thinking. Only SendToUser reaches them. If you have produced a result or finished what they asked, send it now with a SendToUser tool call before continuing or ending the turn. If you are still mid-task, keep working and send the result once you have it.\n</system_reminder>";

const isCommunicationReminder = (message: BotMessage) =>
  message.customType === "openteam-communication-reminder" ||
  ["sandSendMessageReminder", "sandEarlyResultReminder", "sandStartOfTurnAckReminder"].some(
    (flag) =>
      (message.providerOptions?.cursor as Record<string, unknown> | undefined)?.[flag] === true
  );

/** Synthetic notes never reset the real user-turn boundary. */
export function communicationReminder(
  messages: readonly BotMessage[],
  active: Pick<ActiveTurn, "requestSource" | "subagentType">
) {
  if (active.subagentType || !["user", "turn"].includes(active.requestSource)) return null;
  let calls = 0;
  let hasTextSend = false;
  let hasSend = false;
  let alreadyReminded = false;
  const last = messages.at(-1) as (BotMessage & { customType?: string }) | undefined;
  if (last && isCommunicationReminder(last)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]! as BotMessage & { customType?: string };
    if (isCommunicationReminder(message)) {
      if (!hasSend) alreadyReminded = true;
      continue;
    }
    if (
      message.role === "user" &&
      !(message.providerOptions?.cursor as Record<string, unknown> | undefined)?.isUserInfo
    )
      break;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of [...message.content].reverse()) {
      if (!part || typeof part !== "object") continue;
      const call = part as Record<string, unknown>;
      if (!["toolCall", "tool-call"].includes(String(call.type))) continue;
      const name = call.name ?? call.toolName;
      if (name === "SendToUser") {
        hasSend = true;
        if (
          (call.arguments ?? (call.args as unknown)) &&
          typeof (call.arguments ?? call.args) === "object"
        ) {
          hasTextSend ||=
            ((call.arguments ?? call.args) as Record<string, unknown>).type === "text";
        }
      }
      if (!hasSend) calls += 1;
    }
  }
  if (!hasTextSend && calls > 1 && !alreadyReminded) return { kind: "ack", content: ACK_REMINDER };
  if (calls > 6) return { kind: "progress", content: PROGRESS_REMINDER };
  if (hasSend && calls > 0 && !alreadyReminded)
    return { kind: "early-result", content: EARLY_RESULT_REMINDER };
  return null;
}
