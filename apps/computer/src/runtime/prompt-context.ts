import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import type { BotMessage } from "../bot-compaction";
import type { ActiveTurn } from "./types";
import { taskUserInfo, type TaskConfiguration } from "@openteam/contracts/task-configuration";
import { isWallClockCut } from "./stream-deadlines";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export interface CatalogNamespace {
  name: string;
  description?: string;
  namespaceStatus?: string;
  /** A first-party tool given with its schema is preloaded: the catalog carries its full descriptor, so it needs no lookup. */
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

/** First-party tools whose schema rides in the catalog. Every browser and worker task starts with Task,
 * and looking up its schema first cost the main agent a model round trip before each dispatch. A quick
 * lookup starts with WebSearch or WebFetch; with their schemas a lookup away, the main agent handed even
 * one-question research to an executor. */
export const PRELOADED_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "WebFetch", "WebSearch"]);

const catalogAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The reference's catalog block: cursor first, tool names sorted, and only the
 * first-party namespace carries instructions. A connection that is not ready is
 * listed by status alone, since none of its tools can be called yet.
 */
export function renderDynamicToolCatalog(namespaces: readonly CatalogNamespace[]): string | null {
  const entries = catalogEntries(namespaces);
  if (!entries.length) return null;
  const preloaded = namespaces
    .filter((namespace) => namespace.name === "cursor")
    .flatMap((namespace) => namespace.tools.filter((tool) => PRELOADED_TOOL_NAMES.has(tool.name) && tool.inputSchema !== undefined))
    .map((tool) => JSON.stringify({ namespace: "cursor", tool: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  return [
    "<dynamic_tool_catalog>",
    `These dynamic tool namespaces were available when this conversation started. Availability may have changed, so use \`GetDynamicTools\` to check current state before calling \`CallDynamicTool\`${preloaded.length ? ", except for the tools in <preloaded_tool_schemas>, which you can call with `CallDynamicTool` directly" : ""}.`,
    "",
    "<dynamic_tool_namespaces>",
    ...entries,
    "</dynamic_tool_namespaces>",
    ...(preloaded.length ? ["<preloaded_tool_schemas>", ...preloaded, "</preloaded_tool_schemas>"] : []),
    "</dynamic_tool_catalog>",
  ].join("\n");
}

/** The first-party namespace alone, which is what the reference re-announces when it changes mid-conversation. */
export function renderCursorNamespaceStatement(namespaces: readonly CatalogNamespace[]): string {
  const [entry] = catalogEntries(namespaces.filter((namespace) => namespace.name === "cursor"));
  return `<dynamic_tool_namespaces>\n${entry ?? '(no built-in "cursor" namespace is available; discover the remaining namespaces with the discovery tool)'}\n</dynamic_tool_namespaces>`;
}

function catalogEntries(namespaces: readonly CatalogNamespace[]): string[] {
  const ordered = [...namespaces].sort((a, b) => Number(b.name === "cursor") - Number(a.name === "cursor"));
  return ordered.flatMap((namespace) => {
    const source = namespace.name === "cursor" ? "cursor" : "mcp";
    if (source === "mcp" && namespace.namespaceStatus && namespace.namespaceStatus !== "ready")
      return [`<namespace name="${catalogAttribute(namespace.name)}" status="${namespace.namespaceStatus}" source="mcp" />`];
    if (!namespace.tools.length) return [];
    const tools = namespace.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)).join(", ");
    const instructions = source === "cursor" && namespace.description ? ` namespaceUseInstructions="${catalogAttribute(namespace.description)}"` : "";
    return [`<namespace name="${catalogAttribute(namespace.name)}" tools="${catalogAttribute(tools)}"${instructions} source="${source}" />`];
  });
}

export function enrichUserInfo(
  base: string,
  input: {
    cwd: string;
    /** The rendered <dynamic_tool_catalog>, pinned for the compaction epoch. */
    catalog: string | null;
    taskConfiguration?: TaskConfiguration;
    subagent?: boolean;
  }
): string {
  const environment = [
    `OS Version: ${platform()} ${release()}`,
    "Shell: /bin/bash",
    "The Linux computer supports passwordless sudo for system changes and package installation.",
    existsSync(join(input.cwd, ".git"))
      ? `Workspace Path: ${input.cwd}`
      : `Workspace Path: ${input.cwd}\nIf editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so.`,
  ].join("\n\n");
  const context = base.replace(/<user_info>(\n?)/, (_, newline: string) => `<user_info>\n${environment}\n${newline}`);
  // The reference lists subagent types right after memory, before teammates and skills.
  const roster = input.subagent ? null : taskUserInfo(input.taskConfiguration);
  const at = roster ? context.search(/\n\n<(?:teammates|agent_skills)>/) : -1;
  return [
    !roster ? context : at < 0 ? `${context}\n\n${roster}` : `${context.slice(0, at)}\n\n${roster}${context.slice(at)}`,
    input.catalog ?? [],
  ].flat().join("\n\n");
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
export const END_TURN_HOLD_REMINDER =
  "<system_reminder>\nYour turn did not end. This end_turn call succeeded, but a call alongside it failed; see that call's result. If the failure matters to the user, fix it without resending what already went out. Otherwise, stop.\n</system_reminder>";

/** Sent once per turn after a response is cut off at the output limit, as in the reference. */
export const OUTPUT_LIMIT_REMINDER =
  "<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>";

/** The latest response hit the output limit, or the turn's first wall-clock cut, which the reference treats as one; this turn has not been told yet. */
export const owesOutputLimitReminder = (messages: readonly BotMessage[], active: Pick<ActiveTurn, "outputLimitReminded">): boolean => {
  const last = messages.findLast((message) => message.role === "assistant");
  return !active.outputLimitReminded && (last?.stopReason === "length" || (last !== undefined && isWallClockCut(last as { stopReason?: string; errorMessage?: string })));
};

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
