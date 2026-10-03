import { assertComputerMcpRuntime } from "@openteam/plugin-sdk";
import { StdioMcpManager } from "./mcp-manager";

/** Packaged MCPs run on the bot computer; retired desktop configs fail closed. */
export class McpRuntimeRouter {
  constructor(private readonly computer: StdioMcpManager) {}
  async discover(id: string, configuration: unknown): Promise<unknown[]> {
    assertComputerMcpRuntime(configuration);
    return this.computer.discover(id, configuration);
  }
  async call(id: string, configuration: unknown, toolName: string, args: unknown): Promise<unknown> {
    assertComputerMcpRuntime(configuration);
    return this.computer.call(id, configuration, toolName, args);
  }
  async close(id: string) { await this.computer.close(id); }
  async closeAll() { await this.computer.closeAll(); }
}
