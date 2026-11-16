import { parsePluginDefinition } from "@openteam/plugin-sdk";

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: "echo", description: "Echo text.", inputSchema: object({ text: { type: "string" } }), risk: "read", defaultDecision: "allow" },
  { name: "add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), risk: "read", defaultDecision: "allow" },
  { name: "remember_note", description: "Record a note.", inputSchema: object({ note: { type: "string" } }), risk: "write", defaultDecision: "prompt" },
];

/** A local no-auth HTTP MCP server with echo/add/remember_note tools, and a plugin definition for it. */
export function startUtilityMcp() {
  const notes: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
    const message = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, any> } };
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "utility", version: "1" } };
    else if (message.method === "tools/list") result = { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    else if (message.method === "tools/call") {
      const args = message.params?.arguments ?? {};
      const value = message.params?.name === "echo" ? { text: args.text }
        : message.params?.name === "add" ? { value: Number(args.a) + Number(args.b) }
        : (notes.push(String(args.note)), { remembered: true });
      result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    } else return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  const definition = (key = "test-utility") => parsePluginDefinition({
    schemaVersion: 1, key, version: "1.0.1", name: "Utility test fixture", description: "Echo, add and note tools.", publisher: "OpenTeam",
    category: "Developer Tools", featured: false, components: ["mcp"], skills: [],
    connections: [{ key: "utility", name: "Utility test fixture", transport: "http", auth: "none", endpoint: `http://127.0.0.1:${server.port}/mcp`, tools }],
  });
  return { definition, notes, close: () => server.stop(true) };
}
