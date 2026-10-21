import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";

const manager = new StdioMcpManager();
const configuration = { command: "node", args: [join(import.meta.dir, "sloppy-tools-mcp.mjs")] };
const warn = console.warn;
const leftOut: string[] = [];
console.warn = (message: string) => { leftOut.push(message); };
try {
  const tools = await manager.discover("sloppy", configuration) as Array<{ name: string; inputSchema: { type?: string }; outputSchema?: unknown }>;
  const names = tools.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(["echo", "untyped", "odd_output"])) throw new Error(`Unexpected tools: ${JSON.stringify(tools)}`);
  if (tools[1]!.inputSchema.type !== "object") throw new Error("The missing schema type was not filled");
  if ("outputSchema" in tools[2]!) throw new Error("The rejected outputSchema was kept");
  if (!leftOut.some((line) => line.includes("Left out an MCP tool whose definition is invalid: 42"))) throw new Error(`No left-out log: ${leftOut}`);
  const result = await manager.call("sloppy", configuration, "untyped", { q: "x" });
  if (!JSON.stringify(result).includes('untyped:{\\"q\\":\\"x\\"}')) throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
} finally {
  console.warn = warn;
  await manager.closeAll();
}
