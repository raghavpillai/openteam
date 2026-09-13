import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverAllTools, scopedProcessEnvironment } from "@openteam/plugin-sdk";
import { join } from "node:path";
import { PluginPackageCache } from "./plugin-package-cache";

export interface StdioMcpConfiguration {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface ManagedStdioClient {
  fingerprint: string;
  client: Client;
  transport: StdioClientTransport;
}

const normalized = (value: unknown): StdioMcpConfiguration => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stdio MCP configuration must be an object");
  }
  const config = value as Record<string, unknown>;
  if (typeof config.command !== "string" || !config.command.trim()) {
    throw new Error("stdio MCP command is required");
  }
  return {
    command: config.command,
    args: Array.isArray(config.args)
      ? config.args.filter((item): item is string => typeof item === "string")
      : [],
    env:
      config.env && typeof config.env === "object" && !Array.isArray(config.env)
        ? Object.fromEntries(
            Object.entries(config.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : {},
    cwd: typeof config.cwd === "string" && config.cwd ? config.cwd : undefined,
  };
};

export class StdioMcpManager {
  private readonly clients = new Map<string, ManagedStdioClient>();
  private readonly packages: PluginPackageCache;

  constructor(cacheDirectory = join(process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data", "plugin-runtimes")) {
    this.packages = new PluginPackageCache(cacheDirectory);
  }

  async discover(connectionId: string, input: unknown): Promise<unknown[]> {
    const managed = await this.get(connectionId, normalized(await this.packages.resolve(input)));
    return discoverAllTools((cursor) => managed.client.listTools({ cursor }, { timeout: 30_000 }));
  }

  async call(
    connectionId: string,
    input: unknown,
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const managed = await this.get(connectionId, normalized(await this.packages.resolve(input)));
    return managed.client.callTool(
      {
        name: toolName,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      },
      undefined,
      { timeout: 60_000 }
    );
  }

  async close(connectionId: string): Promise<void> {
    const managed = this.clients.get(connectionId);
    this.clients.delete(connectionId);
    await managed?.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.close(id)));
  }

  private async get(connectionId: string, configuration: StdioMcpConfiguration) {
    const fingerprint = JSON.stringify(configuration);
    const existing = this.clients.get(connectionId);
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) await this.close(connectionId);
    const client = new Client({ name: "openteam-computer", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: configuration.command,
      args: configuration.args,
      env: scopedProcessEnvironment(process.env, configuration.env),
      cwd: configuration.cwd,
      stderr: "pipe",
    });
    const managed = { fingerprint, client, transport };
    transport.stderr?.on("data", (chunk) => {
      let message = String(chunk).trim();
      for (const value of Object.values(configuration.env ?? {})) {
        if (value.length >= 4) message = message.replaceAll(value, "[redacted]");
      }
      if (message) console.error(`[stdio-mcp:${connectionId}] ${message.slice(0, 2_000)}`);
    });
    transport.onerror = () => {
      if (this.clients.get(connectionId) === managed) this.clients.delete(connectionId);
    };
    try {
      await client.connect(transport, { timeout: 30_000 });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.clients.set(connectionId, managed);
    return managed;
  }
}
