import { HOST_BRIDGE_PATHS } from "@openteam/contracts/service-protocol";
import { desktopMcpProvider } from "@openteam/plugin-sdk";

/** The control-token protected host bridge owns native providers and their local consent. */
export class DesktopMcpClient {
  constructor(private readonly token: string, private readonly url =
    process.env.OPENTEAM_HOST_BRIDGE_URL ?? "http://host.docker.internal:8791") {}

  async request(connectionId: string, operation: "discover" | "call" | "close", input?: unknown,
    toolName?: string, args?: unknown): Promise<Record<string, unknown>> {
    const provider = operation === "close" ? undefined : desktopMcpProvider(input);
    if (operation !== "close" && !provider) throw new Error("Desktop MCP configuration is required");
    const response = await fetch(`${this.url}${HOST_BRIDGE_PATHS.mcp}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      // Never forward package files, launch commands, or credentials onto the user's desktop.
      body: JSON.stringify({ connectionId, operation, provider, toolName, arguments: args }),
      signal: AbortSignal.timeout(operation === "close" ? 5_000 : 150_000),
    }).catch(() => { throw new Error("Open the OpenTeam desktop app on the computer running 1Password, then retry. Its local connection is unavailable."); });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Desktop MCP request failed");
    return value;
  }
}
