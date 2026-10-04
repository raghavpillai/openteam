import { assertComputerMcpRuntime } from "@openteam/plugin-sdk";
import { StdioMcpManager } from "./mcp-manager";

/** Packaged MCPs run on the bot computer; retired desktop configs fail closed. */
export class McpRuntimeRouter {
  constructor(private readonly computer: StdioMcpManager) {}
  async discover(id: string, configuration: unknown, generation?: number): Promise<unknown[]> {
    assertComputerMcpRuntime(configuration);
    return this.computer.discover(id, configuration, generation);
  }
  async call(
    id: string,
    configuration: unknown,
    toolName: string,
    args: unknown,
    generation?: number
  ): Promise<unknown> {
    assertComputerMcpRuntime(configuration);
    return this.computer.call(id, configuration, toolName, args, generation);
  }
  async close(id: string, generation?: number) {
    await this.computer.close(id, generation);
  }
  status(id: string) {
    return this.computer.status(id);
  }
  async closeAll() {
    await this.computer.closeAll();
  }
}
