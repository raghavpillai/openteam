import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";

const manager = new StdioMcpManager();
const configuration = {
  command: "node",
  args: [join(import.meta.dir, "stdio-mcp.mjs")],
};
try {
  const tools = await manager.discover("fixture", configuration);
  if (tools.length !== 1 || (tools[0] as { name?: unknown }).name !== "echo") {
    throw new Error(`Unexpected tools: ${JSON.stringify(tools)}`);
  }
  const result = await manager.call("fixture", configuration, "echo", { text: "from stdio" });
  if (JSON.stringify(result).includes("from stdio") === false) {
    throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
  }
} finally {
  await manager.closeAll();
}
