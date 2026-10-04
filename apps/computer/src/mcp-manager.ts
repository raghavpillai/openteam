import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { discoverAllTools, objectValue, scopedProcessEnvironment } from "@openteam/plugin-sdk";
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
  launchFingerprint: string;
  client: Client;
  state: "starting" | "ready" | "error";
  tools: unknown[];
  error?: string;
  abort: AbortController;
  connected: Promise<ManagedStdioClient>;
  discovery?: Promise<unknown[]>;
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
  private readonly closing = new Map<string, Promise<void>>();
  private readonly packages: PluginPackageCache;

  constructor(
    cacheDirectory = join(process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data", "plugin-runtimes"),
    private readonly startupTimeoutMs = 300_000
  ) {
    this.packages = new PluginPackageCache(cacheDirectory);
  }

  async discover(connectionId: string, input: unknown): Promise<unknown[]> {
    const refresh = this.clients.get(connectionId)?.state === "ready";
    const managed = await this.get(connectionId, input);
    return refresh ? this.refreshTools(managed) : managed.tools;
  }

  /** Passive health probes never launch a process, refresh tokens, or open a login page. */
  status(connectionId: string) {
    const managed = this.clients.get(connectionId);
    return managed
      ? {
          state: managed.state,
          tools: managed.state === "ready" ? managed.tools : [],
          error: managed.error,
        }
      : { state: "stopped" as const, tools: [] };
  }

  async call(
    connectionId: string,
    input: unknown,
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const managed = await this.get(connectionId, input);
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
    const closing = this.closing.get(connectionId);
    if (closing) return closing;
    const managed = this.clients.get(connectionId);
    this.clients.delete(connectionId);
    if (!managed) return;
    managed.abort.abort(new Error("MCP connection was stopped"));
    const pending = managed.client.close().catch(() => undefined);
    this.closing.set(connectionId, pending);
    try {
      await pending;
    } finally {
      if (this.closing.get(connectionId) === pending) this.closing.delete(connectionId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...new Set([...this.clients.keys(), ...this.closing.keys()])].map((id) => this.close(id))
    );
  }

  private async get(connectionId: string, input: unknown): Promise<ManagedStdioClient> {
    const closing = this.closing.get(connectionId);
    if (closing) await closing;
    const fingerprint = JSON.stringify(input);
    const { env: _env, ...launchConfiguration } = objectValue(input);
    const launchFingerprint = JSON.stringify(launchConfiguration);
    const existing = this.clients.get(connectionId);
    if (existing?.fingerprint === fingerprint) {
      if (existing.state === "error") throw new Error(existing.error);
      return existing.connected;
    }
    // Host-managed access tokens rotate in the child's environment. Replace a
    // ready process when only its environment changes, but never interrupt an
    // in-progress login or let a stale launch definition replace a newer one.
    if (existing?.state === "ready" && existing.launchFingerprint === launchFingerprint) {
      await this.close(connectionId);
      return this.get(connectionId, input);
    }
    if (existing) throw new Error("MCP configuration changed; reconnect to apply it");
    const client = new Client({ name: "openteam-computer", version: "0.0.0" });
    const managed: ManagedStdioClient = {
      fingerprint,
      launchFingerprint,
      client,
      state: "starting",
      tools: [],
      abort: new AbortController(),
      connected: undefined!,
    };
    // Publish before package resolution or MCP initialization: every caller
    // shares this process, including callers whose HTTP request times out.
    this.clients.set(connectionId, managed);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (managed.state === "ready") await this.refreshTools(managed).catch(() => {});
    });
    managed.connected = this.start(connectionId, managed, input);
    void managed.connected.catch(() => {});
    return managed.connected;
  }

  private async start(connectionId: string, managed: ManagedStdioClient, input: unknown) {
    try {
      const configuration = normalized(await this.packages.resolve(input));
      managed.abort.signal.throwIfAborted();
      const { client } = managed;
      const transport = new StdioClientTransport({
        command: configuration.command,
        args: configuration.args,
        env: scopedProcessEnvironment(process.env, configuration.env),
        cwd: configuration.cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => {
        let message = String(chunk).trim();
        for (const value of Object.values(configuration.env ?? {})) {
          if (value.length >= 4) message = message.replaceAll(value, "[redacted]");
        }
        if (message) console.error(`[stdio-mcp:${connectionId}] ${message.slice(0, 2_000)}`);
      });
      client.onclose = () => {
        if (managed.state === "ready") {
          managed.state = "error";
          managed.error = "MCP process exited. Reconnect to try again.";
        }
      };
      await client.connect(transport, {
        timeout: this.startupTimeoutMs,
        signal: managed.abort.signal,
      });
      await this.refreshTools(managed);
      managed.abort.signal.throwIfAborted();
      managed.state = "ready";
      return managed;
    } catch (error) {
      managed.state = "error";
      // Keep a failed entry until explicit reconnect. Discovery/calls must not
      // turn an expired login or broken executable into an automatic retry loop.
      managed.error = "MCP startup or sign-in failed. Reconnect to try again.";
      await managed.client.close().catch(() => undefined);
      throw error;
    }
  }

  private async refreshTools(managed: ManagedStdioClient): Promise<unknown[]> {
    if (managed.discovery) return managed.discovery;
    const pending = discoverAllTools((cursor) =>
      managed.client.listTools({ cursor }, { timeout: 30_000, signal: managed.abort.signal })
    );
    managed.discovery = pending;
    try {
      return (managed.tools = await pending);
    } finally {
      if (managed.discovery === pending) managed.discovery = undefined;
    }
  }
}
