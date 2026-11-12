import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { discoverAllTools, MCP_TOOL_CALL_TIMEOUT_MS, repairedToolsPage, type PluginToolDefinition } from "@openteam/plugin-sdk";
import { ApiError } from "@openteam/contracts";

/** Bun's fetch otherwise gives up on a quiet tool call after 300 seconds, inside its own budget. */
const LONG_CALL_INIT = { timeout: false } as RequestInit;

/** A caller can stop waiting for shared startup without cancelling other callers. */
const withAbort = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
};

export const isMcpAuthorizationError = (error: unknown): boolean =>
  error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401);

export interface HttpMcpConnectionOptions {
  endpoint: string;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  runtimeGeneration?: number;
  beforeRequest?: (method?: string, toolName?: string) => Promise<void>;
}

interface ManagedHttpClient {
  fingerprint: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
}

interface PendingHttpClient {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<ManagedHttpClient>;
}

const fingerprintFor = (options: HttpMcpConnectionOptions): string =>
  JSON.stringify({ endpoint: options.endpoint, headers: options.headers ?? {}, runtimeGeneration: options.runtimeGeneration });

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
  };
};

/** Owns live Streamable HTTP sessions and keeps tool calls off the renderer/model process. */
export class McpHttpClientManager {
  private readonly clients = new Map<string, ManagedHttpClient>();
  private readonly pending = new Map<string, PendingHttpClient>();
  private readonly authorizations = new Map<string, AbortController>();
  onToolsChanged?: (connectionId: string, tools: PluginToolDefinition[], options: HttpMcpConnectionOptions) => Promise<void>;

  constructor(private readonly connectionTimeoutMs = 30_000) {}

  async discover(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<PluginToolDefinition[]> {
    const managed = await this.get(connectionId, options);
    try {
      return (
        await discoverAllTools((cursor) => repairedToolsPage(
          () => managed.client.listTools({ cursor }, { timeout: 30_000 }),
          () => managed.client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ResultSchema, { timeout: 30_000 }),
          (tool) => { const parsed = ToolSchema.safeParse(tool); return parsed.success ? parsed.data : undefined; },
          (name) => console.warn(`[mcp:${connectionId}] Left out an MCP tool whose definition is invalid: ${name}`)
        ))
      ).map(toolDefinition);
    } catch (error) {
      await this.discardExpiredSession(connectionId, managed, error);
      throw error;
    }
  }

  async call(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const managed = await withAbort(this.get(connectionId, options), signal);
    try {
      return await managed.client.callTool(
        {
          name: toolName,
          arguments:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        },
        undefined,
        { signal, timeout: MCP_TOOL_CALL_TIMEOUT_MS }
      );
    } catch (error) {
      await this.discardExpiredSession(connectionId, managed, error);
      throw error;
    }
  }

  private async discardExpiredSession(connectionId: string, managed: ManagedHttpClient, error: unknown) {
    // A 404 expires a stateful Streamable HTTP session. Discard it so the next
    // explicit request reinitializes, but never replay an uncertain tool call.
    if (error instanceof StreamableHTTPError && error.code === 404 && this.clients.get(connectionId) === managed)
      await this.close(connectionId);
  }

  async beginOAuth(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<{ authorizationUrl: string }> {
    await this.close(connectionId);
    let authorizationUrl = "";
    const provider = options.authProvider;
    if (!provider) throw new Error("OAuth provider is required");
    // Observe this attempt without mutating a provider another attempt may use.
    const observed = new Proxy(provider, {
      get(target, key) {
        if (key === "redirectToAuthorization") return async (url: URL) => {
          await target.redirectToAuthorization(url);
          authorizationUrl = url.toString();
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await this.authorize(connectionId, { ...options, authProvider: observed });
    if (!authorizationUrl) throw new Error("The MCP server did not request OAuth authorization");
    return { authorizationUrl };
  }

  async finishOAuth(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    authorizationCode: string
  ): Promise<PluginToolDefinition[]> {
    await this.close(connectionId);
    await this.authorize(connectionId, options, authorizationCode);
    return this.discover(connectionId, options);
  }

  private async authorize(connectionId: string, options: HttpMcpConnectionOptions, authorizationCode?: string) {
    const provider = options.authProvider;
    if (!provider) throw new Error("OAuth provider is required");
    const controller = new AbortController();
    // Two starts can both finish close() before either registers its attempt.
    // Replace atomically here too, so the older controller cannot be orphaned.
    this.authorizations.get(connectionId)?.abort(new Error("MCP connection was closed or replaced"));
    this.authorizations.set(connectionId, controller);
    const deadline = setTimeout(() => controller.abort(new Error("MCP authorization timed out")), this.connectionTimeoutMs);
    try {
      await auth(provider, {
        serverUrl: options.endpoint,
        authorizationCode,
        scope: provider.clientMetadata.scope,
        fetchFn: (url, init) => fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
        }),
      });
      controller.signal.throwIfAborted();
    } finally {
      clearTimeout(deadline);
      if (this.authorizations.get(connectionId) === controller) this.authorizations.delete(connectionId);
    }
  }

  async restart(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<PluginToolDefinition[]> {
    await this.close(connectionId);
    return this.discover(connectionId, options);
  }

  async close(connectionId: string): Promise<void> {
    const authorization = this.authorizations.get(connectionId);
    this.authorizations.delete(connectionId);
    authorization?.abort(new Error("MCP connection was closed or replaced"));
    const pending = this.pending.get(connectionId);
    this.pending.delete(connectionId);
    pending?.controller.abort(new Error("MCP connection was closed or replaced"));
    const managed = this.clients.get(connectionId);
    this.clients.delete(connectionId);
    await managed?.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.pending.keys(), ...this.authorizations.keys()])]
      .map((connectionId) => this.close(connectionId)));
  }

  private async get(
    connectionId: string,
    options: HttpMcpConnectionOptions
  ): Promise<ManagedHttpClient> {
    const fingerprint = fingerprintFor(options);
    const existing = this.clients.get(connectionId);
    if (existing?.fingerprint === fingerprint) return existing;
    const pending = this.pending.get(connectionId);
    if (pending?.fingerprint === fingerprint) return pending.promise;
    // Register the pending attempt before awaiting access validation, so close
    // also fences a request whose validation is still running.
    pending?.controller.abort(new Error("MCP connection was closed or replaced"));
    const controller = new AbortController();
    // Client.connect's request timeout starts after transport.start; bound the
    // entire handshake, including a legacy SSE server that never sends headers.
    const deadline = setTimeout(() => controller.abort(new Error("MCP connection timed out")), this.connectionTimeoutMs);
    const attempt: PendingHttpClient = {
      fingerprint,
      controller,
      promise: Promise.resolve().then(async () => {
        // A stale caller must not evict a newer, valid cached session.
        if (options.beforeRequest) await withAbort(options.beforeRequest(), controller.signal);
        controller.signal.throwIfAborted();
        const previous = this.clients.get(connectionId);
        if (previous) {
          this.clients.delete(connectionId);
          await previous.client.close().catch(() => undefined);
        }
        controller.signal.throwIfAborted();
        return this.create(connectionId, options, controller.signal);
      })
        .then(async managed => {
          if (this.pending.get(connectionId) !== attempt) {
            await managed.client.close().catch(() => undefined);
            throw new Error("MCP connection was closed or replaced");
          }
          this.clients.set(connectionId, managed);
          return managed;
        })
        .finally(() => {
          clearTimeout(deadline);
          if (this.pending.get(connectionId) === attempt) this.pending.delete(connectionId);
        }),
    };
    this.pending.set(connectionId, attempt);
    return attempt.promise;
  }

  private async create(
    connectionId: string,
    options: HttpMcpConnectionOptions,
    signal: AbortSignal
  ): Promise<ManagedHttpClient> {
    try {
      return await this.connectTransport(connectionId, options, "streamable-http", signal);
    } catch (streamableError) {
      signal.throwIfAborted();
      // Authorization failure does not mean the server uses the legacy transport.
      if (streamableError instanceof ApiError || isMcpAuthorizationError(streamableError)) throw streamableError;
      try {
        return await this.connectTransport(connectionId, options, "sse", signal);
      } catch (sseError) {
        signal.throwIfAborted();
        if (sseError instanceof ApiError || isMcpAuthorizationError(sseError)) throw sseError;
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
    kind: "streamable-http" | "sse",
    signal: AbortSignal
  ): Promise<ManagedHttpClient> {
    signal.throwIfAborted();
    const connectionFetch: FetchLike = async (url, init) => {
      let message: { method?: string; params?: { name?: string } } | undefined;
      if (typeof init?.body === "string") {
        try { message = JSON.parse(init.body); } catch { /* OAuth requests are form-encoded. */ }
      }
      const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      if (options.beforeRequest)
        await withAbort(options.beforeRequest(message?.method, message?.params?.name), requestSignal);
      return fetch(url, {
        ...LONG_CALL_INIT,
        ...init,
        signal: requestSignal,
      });
    };
    const client = new Client(
      { name: "openteam", version: "0.0.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: () => {
              if (this.clients.get(connectionId) === managed) {
                void this.discover(connectionId, options)
                  .then((tools) => this.clients.get(connectionId) === managed
                    ? this.onToolsChanged?.(connectionId, tools, options)
                    : undefined)
                  .catch(() => undefined);
              }
            },
          },
        },
      }
    );
    const transport =
      kind === "streamable-http"
        ? new StreamableHTTPClientTransport(new URL(options.endpoint), {
            authProvider: options.authProvider,
            fetch: connectionFetch,
            requestInit: { headers: options.headers, ...LONG_CALL_INIT },
            reconnectionOptions: {
              initialReconnectionDelay: 500,
              maxReconnectionDelay: 10_000,
              reconnectionDelayGrowFactor: 1.7,
              maxRetries: 3,
            },
          })
        : new SSEClientTransport(new URL(options.endpoint), {
            authProvider: options.authProvider,
            requestInit: { headers: options.headers, ...LONG_CALL_INIT },
            fetch: connectionFetch,
          });
    const managed = { fingerprint: fingerprintFor(options), client, transport };
    client.onclose = () => {
      if (this.clients.get(connectionId) === managed) this.clients.delete(connectionId);
    };
    try {
      await client.connect(transport, { timeout: this.connectionTimeoutMs, signal });
      signal.throwIfAborted();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return managed;
  }
}
