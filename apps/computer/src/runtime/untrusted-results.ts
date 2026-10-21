import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { repairImageHistory } from "./image-input";

const TAG = "cursor_untrusted_data_1337";
const fenced = new WeakSet<object>();
/** Any spelling of the fence name inside content or a source cannot open or close a fence. */
const stripTag = (text: string) => text.replace(/cursor_untrusted_data_1337/gi, "cursor_untrusted_data_redacted");
const sanitizeSource = (source: string) => stripTag(source).replace(/["<>]/g, "");
/** Page text cannot fake a new line of the transcript with an exotic line break. */
const confineLineBreaks = (text: string) =>
  text.replace(/\r\n|[\r\v\f\u001c-\u001e\u0085\u2028\u2029]/gu, (found) =>
    found === "\r\n" ? "\n" : found === "\r" ? "\\r" : `\\u${found.charCodeAt(0).toString(16).padStart(4, "0")}`);
const carriesPageText = (source: string) => source === "WebFetch" || source === "WebSearch" || source.startsWith("browser_");
const TRAILING_REMINDER = /\n*(<system_reminder>\n[\s\S]*?\n<\/system_reminder>)\s*$/;

/** Applied at the model boundary; original tool receipts remain intact for UI,
 * replay and audit. Source text cannot synthesize a structural closing fence. */
export function fenceToolResults<T extends { role: string }>(messages: readonly T[]): T[] {
  const sources = new Map<string, string>();
  for (const message of messages) {
    const content = (message as T & { content?: unknown }).content;
    if (message.role !== "assistant" || !Array.isArray(content)) continue;
    for (const part of content)
      if (
        part?.type === "toolCall" &&
        part.name === "CallDynamicTool" &&
        typeof part.arguments?.namespace === "string" &&
        typeof part.arguments?.toolName === "string"
      )
        sources.set(part.id, part.arguments.namespace === "cursor" ? part.arguments.toolName : `${part.arguments.namespace}.${part.arguments.toolName}`);
  }
  return messages.map((message) => {
    if (message.role !== "toolResult" || fenced.has(message)) return message;
    const result = message as T & {
      toolName: string;
      toolCallId?: string;
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      details?: { systemReminders?: unknown };
    };
    // As in the reference: nothing to fence, or the runtime's own unknown-tool answer.
    if (!result.content.length || (result.isError && result.content.length === 1 && result.content[0]!.text?.startsWith("Tool not found: ")))
      return message;
    const source = sources.get(result.toolCallId ?? "") ?? result.toolName;
    const confine = carriesPageText(source);
    const body: Array<{ type: string; text?: string }> = [];
    // Host reminders follow the fence: fenced text claiming to be from the system is forged.
    const reminders = Array.isArray(result.details?.systemReminders)
      ? result.details.systemReminders.filter((reminder): reminder is string => typeof reminder === "string")
      : [];
    let run: string[] = [];
    const flush = () => {
      if (!run.length) return;
      body.push({ type: "text", text: stripTag(run.join("\n")) });
      run = [];
    };
    for (const part of result.content) {
      if (part.type !== "text" || typeof part.text !== "string") {
        flush();
        body.push(part);
        continue;
      }
      // A host reminder appended to a result is read after the fence, outside the untrusted data.
      const reminder = TRAILING_REMINDER.exec(part.text);
      const text = reminder ? part.text.slice(0, reminder.index) : part.text;
      if (reminder) reminders.push(reminder[1]!);
      run.push(confine ? confineLineBreaks(text) : text);
    }
    flush();
    const wrapped = {
      ...result,
      content: [
        { type: "text", text: `<${TAG} source="${sanitizeSource(source)}">` },
        ...body,
        { type: "text", text: `</${TAG}>` },
        ...reminders.map((text) => ({ type: "text", text })),
      ],
    };
    fenced.add(wrapped);
    return wrapped;
  });
}

const ABORTED = /^(?:Error: )?(?:Operation aborted|This operation was aborted|The operation was aborted\.?|Request was aborted\.?)$/i;
const interrupted = (toolName: string, elapsedMs?: number) => {
  const after = elapsedMs === undefined ? "" : ` after ${elapsedMs}ms`;
  if (toolName === "AwaitShell") return `Error: Await was interrupted by the user${after}.`;
  if (toolName === "Shell") return "Error: Shell command was interrupted before it completed. It may still be running.";
  return `Error: ${toolName} was interrupted by the user${after} before it completed.`;
};

/**
 * A call cut off by a stop reads as interrupted, as in the reference, rather
 * than "Operation aborted" or the provider layer's "No result provided" for a
 * call that never got a result.
 */
export function settleInterruptedToolCalls<T extends { role: string }>(messages: readonly T[]): T[] {
  const output: T[] = [];
  const issued = new Map<string, { name: string; at?: number }>();
  let pending: Array<{ id: string; name: string }> = [];
  const answered = new Set<string>();
  const settle = () => {
    for (const call of pending)
      if (!answered.has(call.id))
        output.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true,
          content: [{ type: "text", text: interrupted(call.name) }], timestamp: Date.now() } as unknown as T);
    pending = [];
    answered.clear();
  };
  for (const message of messages) {
    const record = message as T & { content?: any; stopReason?: string; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean };
    if (message.role === "assistant") {
      settle();
      // The provider layer drops failed and aborted responses, calls and all.
      if (record.stopReason !== "error" && record.stopReason !== "aborted" && Array.isArray(record.content)) {
        pending = record.content.filter((part: any) => part?.type === "toolCall" && typeof part.id === "string")
          .map((part: any) => ({ id: part.id, name: part.name }));
        for (const call of pending) issued.set(call.id, { name: call.name, at: record.timestamp });
      }
      output.push(message);
      continue;
    }
    if (message.role === "toolResult") {
      answered.add(String(record.toolCallId));
      const text = Array.isArray(record.content) && record.content.length === 1 ? record.content[0]?.text : undefined;
      if (record.isError && typeof text === "string" && ABORTED.test(text.trim())) {
        const call = issued.get(String(record.toolCallId));
        const elapsed = typeof call?.at === "number" && typeof record.timestamp === "number" ? Math.max(0, record.timestamp - call.at) : undefined;
        output.push({ ...record, content: [{ type: "text", text: interrupted(String(record.toolName), elapsed) }] } as T);
        continue;
      }
      output.push(message);
      continue;
    }
    // Every other message reaches the provider as a user turn, which ends the call batch there.
    settle();
    output.push(message);
  }
  settle();
  return output;
}

export function untrustedResultsExtension(): {
  name: string;
  hidden: boolean;
  factory: ExtensionFactory;
} {
  return {
    name: "openteam-untrusted-results",
    hidden: true,
    factory(pi) {
      pi.on("context", async (event) => ({ messages: fenceToolResults(settleInterruptedToolCalls(await repairImageHistory(event.messages))) }));
      // A connector reports its own failures in a successful call; flag those like thrown errors.
      pi.on("tool_result", async (event) =>
        (event.details as { isError?: unknown } | undefined)?.isError === true ? { isError: true } : undefined);
    },
  };
}
