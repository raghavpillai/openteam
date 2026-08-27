import { afterEach, describe, expect, test } from "bun:test";
import { discoverRemoteTools, invokeRemoteTool } from "../src/services/plugin-service";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("remote MCP transport", () => {
  test("initializes a streamable HTTP session, discovers tools, and invokes one", async () => {
    const methods: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
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

    expect((await discoverRemoteTools(endpoint)).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await invokeRemoteTool(endpoint, "echo", { text: "hello" })).toMatchObject({
      content: [{ type: "text" }],
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(sessionHeaders.filter((header) => header === "fixture-session")).toHaveLength(4);
  });
});
