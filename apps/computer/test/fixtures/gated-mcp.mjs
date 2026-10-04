import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Models an OAuth bridge: starting a process opens one consent page; MCP
// initialization cannot complete until the person approves it.
const directory = process.argv[2];
await appendFile(join(directory, "starts"), `${process.pid}\n`);
if (process.env.MCP_FIXTURE_EXIT_BEFORE_INIT === "yes") process.exit(1);
while (true) {
  try {
    await access(join(directory, "approved"));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const server = new Server({ name: "gated-login", version: "1" }, { capabilities: { tools: { listChanged: true } } });
let tools = [{ name: "pid", inputSchema: { type: "object" } }];
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await appendFile(join(directory, "lists"), `${process.pid}\n`);
  if (process.env.MCP_FIXTURE_WAIT_FOR_LIST === "yes") {
    while (true) {
      try { await access(join(directory, "listed")); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
  }
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.arguments?.exit) setTimeout(() => process.exit(0), 25);
  if (request.params.arguments?.changeTools) {
    tools = [{ name: "updated", inputSchema: { type: "object" } }];
    await server.sendToolListChanged();
  }
  return { content: [{ type: "text", text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
