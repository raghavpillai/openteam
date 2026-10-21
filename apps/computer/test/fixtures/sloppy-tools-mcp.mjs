import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A server whose listing mixes sloppy and invalid tool definitions with good ones. */
const server = new Server({ name: "openteam-sloppy-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    // No inputSchema.type: the reference fills "object".
    { name: "untyped", description: "Missing schema type.", inputSchema: { properties: { q: { type: "string" } } } },
    // An outputSchema the SDK rejects: the reference keeps the tool without it.
    { name: "odd_output", description: "Bad output schema.", inputSchema: { type: "object" }, outputSchema: { type: "string" } },
    // Still invalid after repair: left out.
    { name: 42, description: "Not a real tool." },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}` }],
}));
await server.connect(new StdioServerTransport());
