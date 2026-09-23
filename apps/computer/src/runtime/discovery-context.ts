import { createHash } from "node:crypto";
import type { BotMessage } from "../bot-compaction";

/** Compact exact repeated schema receipts only within the current projection.
 * The original tape and at least one complete, paired receipt remain intact.
 * Recompute after compaction so references never point into removed history. */
export function compactRepeatedDiscovery(messages: readonly BotMessage[]): BotMessage[] {
  const lookups = new Map<string, { namespace: string; toolName?: string }>();
  const receipts = new Map<string, string>();
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content) &&
        !["error", "aborted"].includes(String(message.stopReason))) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; name?: string; id?: string; arguments?: Record<string, unknown> };
        const args = call.arguments;
        if (call.type === "toolCall" && call.name === "GetDynamicTools" && call.id &&
            typeof args?.namespace === "string" && (!args.pattern || args.toolName) &&
            (args.toolName === undefined || typeof args.toolName === "string")) {
          lookups.set(call.id, { namespace: args.namespace, toolName: args.toolName as string | undefined });
        }
      }
    }
    if (message.role !== "toolResult" || message.toolName !== "GetDynamicTools" ||
        message.isError || typeof message.toolCallId !== "string") return message;
    const lookup = lookups.get(message.toolCallId);
    if (!lookup || !Array.isArray(message.content) || message.content.length !== 1) return message;
    const part = message.content[0];
    if (part?.type !== "text" || typeof part.text !== "string" || part.text.length < 512) return message;
    let result: any;
    try { result = JSON.parse(part.text); } catch { return message; }
    const descriptors = lookup.toolName ? [result] :
      result?.mode === "namespace" && result.namespace === lookup.namespace &&
      (!result.namespaceStatus || result.namespaceStatus === "ready") && Array.isArray(result.tools)
        ? result.tools : [];
    if (!descriptors.length || !descriptors.every((tool: any) =>
      typeof tool?.tool === "string" && (!lookup.toolName || tool.tool === lookup.toolName) &&
      typeof tool.description === "string" && tool.inputSchema &&
      typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema))) return message;
    const key = createHash("sha256").update(JSON.stringify([lookup, message.content])).digest("hex");
    const earlier = receipts.get(key);
    if (!earlier) {
      receipts.set(key, message.toolCallId);
      return message;
    }
    return {
      ...message,
      content: [{ type: "text", text: JSON.stringify({
        mode: "unchanged",
        namespace: lookup.namespace,
        ...(lookup.toolName ? { tool: lookup.toolName } : {}),
        schemaSourceToolCallId: earlier,
        message: "These tool definitions are identical to the complete GetDynamicTools result above. Use those definitions; they remain in the current context.",
      }) }],
    };
  });
}
