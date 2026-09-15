import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const TAG = "cursor_untrusted_data_1337";
const fenced = new WeakSet<object>();
const attribute = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!
  );

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
      content: Array<{ type: string; text?: string }>;
    };
    const wrapped = {
      ...result,
      content: [
        {
          type: "text",
          text: `<${TAG} source="${attribute(sources.get(result.toolCallId ?? "") ?? result.toolName)}">`,
        },
        ...result.content.map((part) =>
          part.type === "text" && typeof part.text === "string"
            ? { ...part, text: part.text.replace(/<(\/?cursor_untrusted_data_1337\b)/g, "&lt;$1") }
            : part
        ),
        { type: "text", text: `</${TAG}>` },
      ],
    };
    fenced.add(wrapped);
    return wrapped;
  });
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
      pi.on("context", (event) => ({ messages: fenceToolResults(event.messages) }));
    },
  };
}
