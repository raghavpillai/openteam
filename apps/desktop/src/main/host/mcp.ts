import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverAllTools, scopedProcessEnvironment } from "@openteam/plugin-sdk";

export async function resolveOnePasswordCommand(): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("1Password MCP requires macOS or Linux. Windows is not supported by 1Password.");
  const candidates = [
    ...(process.platform === "darwin" ? ["/Applications/1Password.app/Contents/MacOS/1password-mcp"] :
      ["/opt/1Password/1password-mcp", "/usr/bin/1password-mcp"]),
    ...(process.env.PATH ?? "").split(delimiter).filter((path) => path.startsWith("/"))
      .map((path) => join(path, "1password-mcp")),
  ];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next installed location. */ }
  }
  throw new Error("Install or update 1Password, select Settings → Developer → Integrate with MCP clients, complete any macOS setup prompt, and retry. Older versions also require Settings → Labs → MCP Server.");
}

type ManagedClient = { client: Client; transport: StdioClientTransport };

/** Fixed vendor adapter: the authenticated bridge cannot launch arbitrary package commands. */
export class HostMcpManager {
  private readonly clients = new Map<string, Promise<ManagedClient>>();
  constructor(private readonly command = resolveOnePasswordCommand) {}

  private get(id: string): Promise<ManagedClient> {
    const current = this.clients.get(id);
    if (current) return current;
    const pending = (async () => {
      const executable = await this.command();
      // Load the SDK and its schema validators only when a connection is used.
      // Constructing the host bridge must not pay this cost on every app launch.
      const { Client, StdioClientTransport } = await import("./mcp-runtime");
      const client = new Client({ name: "OpenTeam", version: "0.0.1" });
      const env = scopedProcessEnvironment(process.env);
      // 1Password's Linux desktop IPC needs these session locations, never app credentials.
      for (const key of ["XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"])
        if (process.env[key]) env[key] = process.env[key]!;
      const transport = new StdioClientTransport({ command: executable, args: [], env, stderr: "pipe" });
      // Provider diagnostics can contain sensitive values; they are not forwarded to application logs.
      transport.stderr?.on("data", () => undefined);
      client.onclose = () => { if (this.clients.get(id) === pending) this.clients.delete(id); };
      try { await client.connect(transport, { timeout: 30_000 }); }
      catch {
        await client.close().catch(() => undefined);
        throw new Error("1Password could not start. Unlock 1Password, enable Settings → Developer → Integrate with MCP clients, and complete any macOS privacy prompt for OpenTeam. Then select Connect again.");
      }
      return { client, transport };
    })();
    this.clients.set(id, pending);
    void pending.catch(() => { if (this.clients.get(id) === pending) this.clients.delete(id); });
    return pending;
  }

  async handle(value: unknown): Promise<Record<string, unknown>> {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const id = input.connectionId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid MCP connection ID");
    if (input.operation === "close") { await this.close(id); return { ok: true }; }
    if (input.provider !== "1password") throw new Error("Unsupported desktop MCP provider");
    if (input.operation !== "discover" && input.operation !== "call") throw new Error("Invalid desktop MCP operation");
    const { client } = await this.get(id);
    if (input.operation === "discover") {
      // tools/list works even when access is disabled. Authenticate before showing Connected.
      try {
        const auth = await client.callTool({ name: "authenticate", arguments: {} }, undefined, { timeout: 120_000 });
        if (auth.isError) throw new Error("Authorization was denied");
      } catch {
        await this.close(id);
        throw new Error("1Password could not authorize this connection. Unlock 1Password and select Settings → Developer → Integrate with MCP clients. Complete any 1Password or macOS setup prompt, then retry and approve the connection. Older versions also require Settings → Labs → MCP Server. If Developer has no MCP option, check availability with 1Password or your administrator.");
      }
      return { tools: await discoverAllTools((cursor) => client.listTools({ cursor }, { timeout: 30_000 })) };
    }
    if (typeof input.toolName !== "string" || !input.toolName) throw new Error("MCP tool name is required");
    const args = input.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP arguments must be an object");
    return { result: await client.callTool({ name: input.toolName, arguments: args as Record<string, unknown> }, undefined, { timeout: 120_000 }) };
  }

  async close(id: string) {
    const pending = this.clients.get(id);
    this.clients.delete(id);
    const managed = await pending?.catch(() => undefined);
    await managed?.client.close().catch(() => undefined);
  }

  async closeAll() { await Promise.all([...this.clients.keys()].map((id) => this.close(id))); }
}
