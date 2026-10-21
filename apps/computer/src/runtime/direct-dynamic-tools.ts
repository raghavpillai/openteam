import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface DirectToolNames {
  /** Tools the model can call by name this turn. */
  registered(): readonly string[];
  /** First-party tools served through CallDynamicTool in the cursor namespace. */
  cursor(): readonly string[];
}

/**
 * The reference executes a first-party dynamic tool called by its bare name.
 * Pi only runs registered tools, so such a call is rewritten into the
 * equivalent CallDynamicTool before it executes, and a call to a tool that
 * exists nowhere gets the reference's "Tool not found" text with the names
 * that do exist.
 */
export function directDynamicToolsExtension(names: DirectToolNames): {
  name: string;
  hidden: boolean;
  factory: ExtensionFactory;
} {
  return {
    name: "openteam-direct-dynamic-tools",
    hidden: true,
    factory(pi) {
      pi.on("message_end", async (event) => {
        const message = event.message as any;
        if (message.role === "assistant" && Array.isArray(message.content)) {
          const registered = new Set(names.registered());
          const cursor = new Set(names.cursor());
          let rewritten = false;
          const content = message.content.map((part: any) => {
            if (part?.type !== "toolCall" || registered.has(part.name) || !cursor.has(part.name)) return part;
            rewritten = true;
            return { ...part, name: "CallDynamicTool", arguments: { namespace: "cursor", toolName: part.name, arguments: part.arguments ?? {} } };
          });
          return rewritten ? { message: { ...message, content } } : undefined;
        }
        const text = message.role === "toolResult" && message.isError && message.content?.length === 1 ? message.content[0]?.text : undefined;
        if (text !== `Tool ${message.toolName} not found`) return undefined;
        const available = [...new Set([...names.registered(), ...names.cursor()])];
        return { message: { ...message, content: [{ type: "text", text: `Tool not found: ${message.toolName}. Available tools: ${available.join(", ")}` }] } };
      });
    },
  };
}
