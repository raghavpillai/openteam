import { afterEach, describe, expect, test } from "bun:test";
import { McpHttpClientManager } from "../../src/plugins/mcp-client-manager";

let server: ReturnType<typeof Bun.serve> | null = null;
const http = new McpHttpClientManager();

afterEach(async () => {
  await http.closeAll();
  server?.stop(true);
  server = null;
});

describe("remote MCP transport", () => {
  test("falls back to legacy SSE and preserves image results and session reuse", async () => {
    const methods: string[] = [];
    let events: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const png = "iVBORw0KGgo=";
    server = Bun.serve({
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
    const options = { endpoint: `http://127.0.0.1:${server.port}/sse` };
    expect((await http.discover("legacy", options)).map((tool) => tool.name)).toEqual(["image"]);
    expect(await http.call("legacy", options, "image", {})).toMatchObject({ content: [{ type: "image", data: png, mimeType: "image/png" }] });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });

  test("initializes and reuses a streamable HTTP session for discovery and calls", async () => {
    const methods: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    server = Bun.serve({
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
