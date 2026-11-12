import { gate } from "./fixtures/gate";
import { afterEach, describe, expect, test } from "bun:test";
import { McpHttpClientManager } from "../../src/plugins/mcp-client-manager";
import { OpenTeamOAuthProvider } from "../../src/plugins/oauth-provider";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const managers: McpHttpClientManager[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture() {
  const manager = new McpHttpClientManager();
  managers.push(manager);
  const entered = gate(), release = gate(), called = gate(), finishCall = gate(), cancelled = gate();
  const initializations: string[] = [];
  const methods: string[] = [];
  const writes = new Map<string, number>();
  const sessions = new Set<string>();
  let unavailable = false, deliveries = 0;
  let droppedResponse: boolean | "truncated" = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const path = new URL(request.url).pathname;
      const message = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: { requestId?: string } } };
      methods.push(message.method);
      if (message.method !== "initialize" && !sessions.has(request.headers.get("mcp-session-id") ?? ""))
        return new Response("Session expired", { status: 404 });
      if (unavailable) return new Response("Provider unavailable", { status: 503 });
      let result: unknown;
      if (message.method === "initialize") {
        initializations.push(path);
        if (path === "/slow" && initializations.filter(p => p === path).length === 1) {
          entered.release(); await release.promise;
        }
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chaos", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: path.slice(1) || "echo", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        deliveries++;
        if (message.params?.name === "wait") { called.release(); await finishCall.promise; }
        const requestId = message.params?.arguments?.requestId;
        if (requestId && !writes.has(requestId)) writes.set(requestId, writes.size + 1);
        if (droppedResponse === "truncated") return new Response('{"jsonrpc":"2.0","id":', { headers: { "content-type": "application/json" } });
        if (droppedResponse) return new Response("Reply lost after applying write", { status: 503 });
        result = { content: [{ type: "text", text: requestId ? String(writes.get(requestId)) : "ok" }] };
      } else {
        if (message.method === "notifications/cancelled") cancelled.release();
        return new Response(null, { status: 202 });
      }
      const session = crypto.randomUUID();
      if (message.method === "initialize") sessions.add(session);
      return Response.json({ jsonrpc: "2.0", id: message.id, result }, {
        headers: message.method === "initialize" ? { "mcp-session-id": session } : {},
      });
    },
  });
  servers.push(server);
  return {
    manager, entered, release, called, finishCall, cancelled, methods, initializations, writes,
    options: (path = "echo") => ({ endpoint: `http://127.0.0.1:${server.port}/${path}` }),
    unavailable: (value: boolean) => { unavailable = value; },
    dropResponse: (value: boolean | "truncated") => { droppedResponse = value; },
    deliveries: () => deliveries,
    expireSessions: () => sessions.clear(),
  };
}

test("a burst of discovery requests shares one initialization", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.manager.discover("burst", f.options())));
  expect(results.every(tools => tools[0]?.name === "echo")).toBe(true);
  expect(f.initializations).toHaveLength(1);
});

test("a lost server session is discarded without replaying the tool and an explicit retry reconnects", async () => {
  const f = fixture();
  await f.manager.discover("expired", f.options());
  f.expireSessions();
  await expect(f.manager.call("expired", f.options(), "write", { requestId: "after-restart" })).rejects.toThrow();
  expect(f.deliveries()).toBe(0);
  expect(await f.manager.call("expired", f.options(), "write", { requestId: "after-restart" })).toMatchObject({ content: [{ text: "1" }] });
  expect(f.initializations).toHaveLength(2);
  expect(f.deliveries()).toBe(1);
});

for (const failure of [true, "truncated"] as const) {
  test(`a ${failure === true ? "lost" : "truncated"} write response is not replayed; the caller can retry its stable request ID`, async () => {
    const f = fixture();
    f.dropResponse(failure);
    await expect(f.manager.call("write", f.options(), "write", { requestId: "one-job" })).rejects.toThrow();
    expect(f.deliveries()).toBe(1);
    f.dropResponse(false);
    expect(await f.manager.call("write", f.options(), "write", { requestId: "one-job" })).toMatchObject({ content: [{ text: "1" }] });
    expect(f.writes.size).toBe(1);
  });
}

test("aborting a blocked call sends cancellation and leaves the connection usable", async () => {
  const f = fixture();
  const controller = new AbortController();
  const call = f.manager.call("cancel", f.options(), "wait", {}, controller.signal).then(() => "completed", () => "cancelled");
  try {
    await f.called.promise;
    controller.abort();
    expect(await call).toBe("cancelled");
    await f.cancelled.promise;
    f.finishCall.release();
    expect(await f.manager.call("cancel", f.options(), "echo", {})).toMatchObject({ content: [{ text: "ok" }] });
    expect(f.initializations).toHaveLength(1);
  } finally { f.finishCall.release(); }
});

describe("remote MCP transport", () => {
  test("falls back to legacy SSE and preserves image results and session reuse", async () => {
    const http = new McpHttpClientManager();
    managers.push(http);
    const methods: string[] = [];
    let events: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const png = "iVBORw0KGgo=";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/sse" && request.method === "GET") {
          const stream = new ReadableStream<Uint8Array>({ start(controller) {
            events = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=fixture\n\n"));
          } });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (url.pathname !== "/messages") return new Response(null, { status: 405 });
        expect(url.searchParams.get("sessionId")).toBe("fixture");
        const message = await request.json() as { id?: number; method: string };
        methods.push(message.method);
        if (message.id !== undefined) {
          let result: unknown;
          if (message.method === "initialize") {
            result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy-fixture", version: "1.0.0" } };
          } else if (message.method === "tools/list") {
            result = { tools: [{ name: "image", inputSchema: { type: "object", properties: {} } }] };
          } else {
            result = { content: [{ type: "image", data: png, mimeType: "image/png" }] };
          }
          events.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`));
        }
        return new Response(null, { status: 202 });
      },
    });
    servers.push(server);
    const options = { endpoint: `http://127.0.0.1:${server.port}/sse` };
    expect((await http.discover("legacy", options)).map((tool) => tool.name)).toEqual(["image"]);
    expect(await http.call("legacy", options, "image", {})).toMatchObject({ content: [{ type: "image", data: png, mimeType: "image/png" }] });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });

  test("initializes and reuses a streamable HTTP session for discovery and calls", async () => {
    const http = new McpHttpClientManager();
    managers.push(http);
    const methods: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") {
          return new Response("SSE not available", {
            status: 405,
            headers: { allow: "POST" },
          });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const message = (await request.json()) as {
          id?: string;
          method: string;
          params?: { name?: string; arguments?: unknown };
        };
        methods.push(message.method);
        sessionHeaders.push(request.headers.get("mcp-session-id"));
        if (message.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1.0.0" },
              },
            },
            { headers: { "mcp-session-id": "fixture-session" } }
          );
        }
        if (message.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (message.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Echo text",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                },
              ],
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: String(message.params?.arguments) }] },
        });
      },
    });
    servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}`;

    expect((await http.discover("connection", { endpoint })).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await http.call("connection", { endpoint }, "echo", { text: "hello" })).toMatchObject({
      content: [{ type: "text" }],
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(sessionHeaders.filter((header) => header === "fixture-session")).toHaveLength(3);
  });
});

// OAuth flows through the manager
const createProvider = () => new OpenTeamOAuthProvider({
  redirectUrl: "http://127.0.0.1/callback", initial: { state: crypto.randomUUID() }, save: async () => {},
});

function setup(timeoutMs?: number) {
  const server = createOAuthMcpFixture(0, { refreshTokens: false });
  const manager = new McpHttpClientManager(timeoutMs);
  const provider = createProvider();
  const options = { endpoint: server.endpoint, authProvider: provider };
  return { server, manager, provider, options };
}

test("closing a connection aborts a stalled token exchange without installing its late token", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  const start = await f.manager.beginOAuth("token", f.options);
  const approve = new URL(start.authorizationUrl); approve.pathname = "/approve";
  const response = await fetch(approve, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
  const callback = new URL(response.headers.get("location")!);
  f.server.setBeforeToken(async () => { entered.release(); await release.promise; });
  const pending = f.manager.finishOAuth("token", f.options, callback.searchParams.get("code")!).then(() => "authorized", () => "cancelled");
  try {
    await entered.promise;
    await f.manager.close("token");
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toBe("cancelled");
    expect(f.provider.tokens()).toBeUndefined();
  } finally { release.release(); await pending; await f.manager.closeAll(); f.server.close(); }
});
