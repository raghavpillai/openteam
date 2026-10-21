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
    "The Linux computer supports passwordless sudo for system changes and package installation.",
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
  "<system_reminder>\nYou opened this turn by calling tools without first sending to the user, so they are watching silence and may think the app froze. Acknowledge them RIGHT NOW by actually invoking the SendToUser tool. Make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Make that first SendToUser a one-line text acknowledgement, before any further tool call, then continue the work. A widget or attachment does not count as this acknowledgement.\n</system_reminder>";
export const PROGRESS_REMINDER =
  "<system_reminder>\nYou have made several tool calls without a SendToUser, so the user is currently watching silence. Actually invoke the SendToUser tool now. Make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Send one brief update in a complete sentence, saying what you found or what happens next, not a play-by-play of each step, before continuing.\n</system_reminder>";

/** Sent once per turn after a response is cut off at the output limit, as in the reference. */
export const OUTPUT_LIMIT_REMINDER =
  "<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>";

/** The latest response hit the output limit and this turn has not been told yet. */
export const owesOutputLimitReminder = (messages: readonly BotMessage[], active: Pick<ActiveTurn, "outputLimitReminded">): boolean =>
  !active.outputLimitReminded && messages.findLast((message) => message.role === "assistant")?.stopReason === "length";

const ACK_THRESHOLD = 1;
const PROGRESS_THRESHOLD = 6;

const cursorFlag = (message: BotMessage, flag: string) =>
  (message.providerOptions?.cursor as Record<string, unknown> | undefined)?.[flag] === true;

const isCommunicationReminder = (message: BotMessage) =>
  message.customType === "openteam-communication-reminder" ||
  ["sandSendMessageReminder", "sandStartOfTurnAckReminder"].some((flag) => cursorFlag(message, flag));

const messageText = (message: BotMessage) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("")
      : "";

/** A user-role message that holds only reminder blocks is host steering, not the start of a turn. */
const isInjectedReminder = (message: BotMessage) => {
  if (isCommunicationReminder(message)) return true;
  if (message.role !== "user" && message.role !== "custom") return false;
  const text = messageText(message).trim();
  return /^<system_reminder>[\s\S]*<\/system_reminder>$/.test(text);
};

/** Every user-role message (a typed message, host note or reminder) restarts the count, as in the reference. */
const isUserRole = (message: BotMessage) =>
  message.role !== "assistant" && message.role !== "toolResult" && !cursorFlag(message, "isUserInfo");

const toolCalls = (message: BotMessage) =>
  message.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((part) => {
        if (!part || typeof part !== "object" || !["toolCall", "tool-call"].includes(String(part.type))) return [];
        const call = part as Record<string, unknown>;
        const args = call.arguments ?? call.args;
        return [{ id: call.id ?? call.toolCallId, name: call.name ?? call.toolName, args: args && typeof args === "object" ? args as Record<string, unknown> : {} }];
      })
    : [];

const isTextSend = (call: ReturnType<typeof toolCalls>[number]) =>
  call.name === "SendToUser" && (call.args.type ?? "text") === "text";

function callsSinceLastSend(messages: readonly BotMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isUserRole(message)) break;
    const calls = toolCalls(message);
    if (calls.some((call) => call.name === "SendToUser")) break;
    count += calls.length;
  }
  return count;
}

/** A text send, or a reaction that went through, acknowledges the turn's real user message. */
function acknowledgedSinceTurnStart(messages: readonly BotMessage[]): boolean {
  const failed = new Set<unknown>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isInjectedReminder(message)) continue;
    if (isUserRole(message)) return false;
    if (message.role === "toolResult" && message.isError === true) failed.add(message.toolCallId);
    for (const call of toolCalls(message)) {
      if (isTextSend(call)) return true;
      if (call.name === "ReactToMessage" && !failed.has(call.id) &&
          messages.slice(index + 1).some((result) => result.role === "toolResult" && result.toolCallId === call.id)) return true;
    }
  }
  return false;
}

/** The ack repeats every 2 silent calls until a text send or reaction; the progress note every 7 after that. */
export function communicationReminder(
  messages: readonly BotMessage[],
  active: Pick<ActiveTurn, "requestSource" | "subagentType">
) {
  if (active.subagentType || !["user", "turn"].includes(active.requestSource)) return null;
  const last = messages.at(-1);
  if (last && isCommunicationReminder(last)) return null;
  const calls = callsSinceLastSend(messages);
  if (calls > ACK_THRESHOLD && !acknowledgedSinceTurnStart(messages)) return { kind: "ack", content: ACK_REMINDER };
  if (calls > PROGRESS_THRESHOLD) return { kind: "progress", content: PROGRESS_REMINDER };
  return null;
}
