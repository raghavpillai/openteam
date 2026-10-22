// The reference's turn-shape rule for its closing-send nudge: a turn ended on
// silent tool calls when its first tool-calling step acknowledged the user and
// no later step delivered anything.

type Part = { type?: string; id?: string; name?: string; arguments?: unknown; text?: string };
type Message = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };

const DELIVERY_TOOLS = new Set(["SendToUser", "ReactToMessage"]);
const SYSTEM_REMINDER_ONLY = /^\s*(?:<system_reminder>(?:(?!<\/system_reminder>)[\s\S])*<\/system_reminder>\s*)+$/;

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const part of content as Part[]) {
    if (part?.type !== "text" || typeof part.text !== "string") return undefined;
    text += part.text;
  }
  return text;
};

const isInjectedReminder = (message: Message): boolean => {
  if (message.role !== "user") return false;
  const text = textOf(message.content);
  return text !== undefined && SYSTEM_REMINDER_ONLY.test(text.trim());
};

const toolCalls = (message: Message): Part[] =>
  message.role === "assistant" && Array.isArray(message.content)
    ? (message.content as Part[]).filter((part) => part?.type === "toolCall")
    : [];

/** A send or reaction, called directly or through the cursor namespace; connector calls never deliver. */
const isDeliveryCall = (part: Part): boolean => {
  if (part.name !== "CallDynamicTool") return DELIVERY_TOOLS.has(part.name ?? "");
  const input = part.arguments as { namespace?: unknown; toolName?: unknown } | undefined;
  return input?.namespace === "cursor" && typeof input.toolName === "string" && DELIVERY_TOOLS.has(input.toolName);
};

const isUndeliveredText = (message: Message): boolean => message.role === "assistant" && toolCalls(message).length === 0;

export function turnEndedOnSilentToolCalls(messages: readonly Message[]): boolean {
  let tail = messages.length - 1;
  while (tail >= 0) {
    const message = messages[tail]!;
    if (message.role !== "user" && message.role !== "assistant" || isUndeliveredText(message) || isInjectedReminder(message)) {
      tail--;
      continue;
    }
    break;
  }
  const tailMessage = messages[tail];
  if (tailMessage?.role !== "assistant") return false;
  const tailCalls = toolCalls(tailMessage);
  if (tailCalls.length === 0) return false;
  const tailDeliveries = tailCalls.filter(isDeliveryCall).length;
  if (tailDeliveries > 0) {
    const undeliveredTextAfter = messages.slice(tail + 1)
      .some((message) => isUndeliveredText(message) && (textOf(message.content) ?? "").trim().length > 0);
    if (!(tailCalls.length > tailDeliveries && undeliveredTextAfter)) return false;
  }
  let boundary = -1;
  for (let index = tail - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isInjectedReminder(message)) continue;
    if (message.role === "user" || message.role === "system") {
      boundary = index;
      break;
    }
  }
  const errored = new Set(messages.filter((message) => message.role === "toolResult" && message.isError === true)
    .map((message) => message.toolCallId));
  let firstCalling = -1;
  let ackedFirst = false;
  let lastDelivery = -1;
  for (let index = boundary + 1; index <= tail; index++) {
    const calls = toolCalls(messages[index]!);
    if (calls.length === 0) continue;
    if (firstCalling === -1) {
      firstCalling = index;
      ackedFirst = calls.some(isDeliveryCall);
      if (ackedFirst) lastDelivery = index;
    } else if (calls.some((call) => isDeliveryCall(call) && !errored.has(call.id))) {
      lastDelivery = index;
    }
  }
  return ackedFirst && lastDelivery === firstCalling;
}
