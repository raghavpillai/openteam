import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginToolDefinition } from "./catalog";

export interface HttpMcpConnectionOptions {
  endpoint: string;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
}

interface ManagedHttpClient {
  fingerprint: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
}

const fingerprintFor = (options: HttpMcpConnectionOptions): string =>
  JSON.stringify({ endpoint: options.endpoint, headers: options.headers ?? {} });

const toolDefinition = (candidate: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): PluginToolDefinition => {
  const destructive = candidate.annotations?.destructiveHint === true;
  const readOnly = candidate.annotations?.readOnlyHint === true;
  return {
    name: candidate.name,
    description: candidate.description ?? "",
    inputSchema: candidate.inputSchema ?? { type: "object" },
    risk: destructive ? "destructive" : readOnly ? "read" : "write",
    defaultDecision: readOnly ? "allow" : "prompt",
  };
};

/** Owns live Streamable HTTP sessions and keeps tool calls off the renderer/model process. */
export class McpHttpClientManager {
  private readonly clients = new Map<string, ManagedHttpClient>();

  async discover(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<PluginToolDefinition[]> {
    const managed = await this.get(connectionId, options);
    const result = await managed.client.listTools({}, { timeout: 30_000 });
    return result.tools.map(toolDefinition);
  }

  async call(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const managed = await this.get(connectionId, options);
    return managed.client.callTool(
      {
        name: toolName,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      },
      undefined,
      { signal, timeout: 60_000 }
    );
  }

  async beginOAuth(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<{ authorizationUrl: string }> {
    await this.close(connectionId);
    let authorizationUrl = "";
    const provider = options.authProvider;
    if (!provider) throw new Error("OAuth provider is required");
    const originalRedirect = provider.redirectToAuthorization.bind(provider);
    provider.redirectToAuthorization = async (url) => {
      authorizationUrl = url.toString();
      await originalRedirect(url);
    };
    await auth(provider, { serverUrl: options.endpoint });
    if (!authorizationUrl) {
      throw new Error("The MCP server did not request OAuth authorization");
    }
    await this.close(connectionId);
    return { authorizationUrl };
  }

  async finishOAuth(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    authorizationCode: string
  ): Promise<PluginToolDefinition[]> {
    await this.close(connectionId);
    if (!options.authProvider) throw new Error("OAuth provider is required");
    await auth(options.authProvider, {
      serverUrl: options.endpoint,
      authorizationCode,
    });
    return this.discover(connectionId, options);
  }

  async restart(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<PluginToolDefinition[]> {
    await this.close(connectionId);
    return this.discover(connectionId, options);
  }

  async close(connectionId: string): Promise<void> {
    const managed = this.clients.get(connectionId);
    this.clients.delete(connectionId);
    await managed?.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((connectionId) => this.close(connectionId)));
  }

  private async get(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<ManagedHttpClient> {
    const fingerprint = fingerprintFor(options);
    const existing = this.clients.get(connectionId);
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) await this.close(connectionId);
    return this.create(connectionId, options);
  }

  private async create(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<ManagedHttpClient> {
    try {
      return await this.connectTransport(connectionId, options, "streamable-http");
    } catch (streamableError) {
      try {
        return await this.connectTransport(connectionId, options, "sse");
      } catch (sseError) {
        const message = (error: unknown) =>
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `MCP connection failed over Streamable HTTP (${message(streamableError)}) and legacy SSE (${message(sseError)})`
        );
      }
    }
  }

  private async connectTransport(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    kind: "streamable-http" | "sse"
  ): Promise<ManagedHttpClient> {
    const client = new Client(
      { name: "openbot", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: () => {
              // The next settings/runtime refresh obtains the latest descriptor snapshot.
            },
          },
        },
      }
    );
    const transport =
      kind === "streamable-http"
        ? new StreamableHTTPClientTransport(new URL(options.endpoint), {
            authProvider: options.authProvider,
            requestInit: { headers: options.headers },
            reconnectionOptions: {
              initialReconnectionDelay: 500,
              maxReconnectionDelay: 10_000,
              reconnectionDelayGrowFactor: 1.7,
              maxRetries: 3,
            },
          })
        : new SSEClientTransport(new URL(options.endpoint), {
            authProvider: options.authProvider,
            requestInit: { headers: options.headers },
            fetch: options.headers
              ? (url, init) =>
                  fetch(url, {
                    ...init,
                    headers: {
                      ...Object.fromEntries(new Headers(init?.headers)),
                      ...options.headers,
                    },
                  })
              : undefined,
          });
    const managed = { fingerprint: fingerprintFor(options), client, transport };
    transport.onerror = () => {
      if (this.clients.get(connectionId) === managed) this.clients.delete(connectionId);
    };
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.clients.set(connectionId, managed);
    return managed;
  }
}
