import { desktopMcpProvider } from "@openteam/plugin-sdk";
import { DesktopMcpClient } from "./desktop-mcp-client";
import { StdioMcpManager } from "./mcp-manager";

export class McpRuntimeRouter {
  private readonly desktopConnections = new Set<string>();
  constructor(private readonly computer: StdioMcpManager, private readonly desktop: DesktopMcpClient) {}

  async discover(id: string, configuration: unknown): Promise<unknown[]> {
    if (desktopMcpProvider(configuration)) {
      this.desktopConnections.add(id);
      await this.computer.close(id);
      const result = await this.desktop.request(id, "discover", configuration);
      return Array.isArray(result.tools) ? result.tools : [];
    }
    await this.closeDesktop(id);
    return this.computer.discover(id, configuration);
  }

  async call(id: string, configuration: unknown, toolName: string, args: unknown): Promise<unknown> {
    if (desktopMcpProvider(configuration)) {
      this.desktopConnections.add(id);
      await this.computer.close(id);
      return (await this.desktop.request(id, "call", configuration, toolName, args)).result;
    }
    await this.closeDesktop(id);
    return this.computer.call(id, configuration, toolName, args);
  }

  private async closeDesktop(id: string) {
    if (!this.desktopConnections.has(id)) return;
    await this.desktop.request(id, "close");
    this.desktopConnections.delete(id);
  }

  async close(id: string) {
    await Promise.all([this.computer.close(id), this.desktop.request(id, "close").catch(() => undefined)]);
    this.desktopConnections.delete(id);
  }

  async closeAll() {
    await Promise.all([this.computer.closeAll(), ...[...this.desktopConnections].map((id) => this.close(id))]);
  }
}
