import { describe, expect, test } from "bun:test";
import type { CallDynamicToolInput, GetDynamicToolsInput } from "@openteam/contracts";
import {
  type DynamicNamespaceDefinition,
  DynamicLookupMiss,
  discoverDynamicTools,
  renderDynamicDiscovery,
  resolveDynamicTool,
} from "../src/dynamic-tool-gateway";

const longDescription = "x".repeat(240);

const catalog = (
  status: DynamicNamespaceDefinition["namespaceStatus"] = "ready"
): DynamicNamespaceDefinition[] => [
  {
    name: "cursor",
    description: "First-party OpenTeam tools",
    kind: "first-party",
    namespaceStatus: "ready",
    tools: [
      {
        name: "SendToAgent",
        description: "Send a message\n\nto another agent",
        inputSchema: { type: "object" },
        source: "first-party",
        decodeArguments: (input) => input,
      },
      {
        name: "Computer",
        description: longDescription,
        inputSchema: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
        },
        source: "first-party",
        decodeArguments: (input) => {
          const action = (input as { action?: unknown }).action;
          if (typeof action !== "string") throw new Error("action is required");
          return { action };
        },
      },
    ],
  },
  {
    name: "gmail",
    description: "Gmail (default)",
    kind: "mcp",
    namespaceStatus: status,
    tools: [
      { name: "search_threads", description: "Search  threads\nline2", inputSchema: { type: "object", required: ["query"] }, source: "gmail/gmail", decodeArguments: (input) => input },
      { name: "get_thread", description: "Get", inputSchema: { type: "object" }, source: "gmail/gmail", decodeArguments: (input) => input },
    ],
  },
];

const discover = (input: GetDynamicToolsInput = {}, options = {}) =>
  discoverDynamicTools(catalog(), input, options);
const render = (input: GetDynamicToolsInput, status?: DynamicNamespaceDefinition["namespaceStatus"]) =>
  renderDynamicDiscovery(discoverDynamicTools(catalog(status), input), input) as any;

describe("OpenTeam dynamic tool gateway", () => {
  test("catalog summaries are bounded and sorted; connector namespaces always state their status", () => {
    const result = render({});
    expect(result.mode).toBe("catalog");
    expect(result.namespaces.map((n: any) => n.namespace)).toEqual(["cursor", "gmail"]);
    expect(result.namespaces[0]).not.toHaveProperty("namespaceStatus");
    expect(result.namespaces[0].tools.map((t: any) => t.tool)).toEqual(["Computer", "SendToAgent"]);
    expect(result.namespaces[0].tools[0].description).toBe(`${"x".repeat(185)}... [truncated]`);
    expect(result.namespaces[1]).toMatchObject({ namespace: "gmail", namespaceStatus: "ready", namespaceDescription: "Gmail (default)" });
  });

  test("namespace and exact lookups return complete descriptors; connector text is whitespace-collapsed", () => {
    expect(render({ namespace: "gmail" })).toEqual({
      mode: "namespace", namespace: "gmail", namespaceStatus: "ready", namespaceDescription: "Gmail (default)",
      tools: [
        { tool: "get_thread", description: "Get", inputSchema: { type: "object" } },
        { tool: "search_threads", description: "Search threads line2", inputSchema: { type: "object", required: ["query"] } },
      ],
    });
    expect(render({ namespace: "cursor", toolName: "SendToAgent" }).description).toBe("Send a message\n\nto another agent");
    expect(render({ namespace: "cursor", toolName: "Computer" }).description).toBe(longDescription);
  });

  test("search matches namespace or tool names, so a service name finds its namespace", () => {
    expect(render({ pattern: "gmail" }).matches).toEqual([
      { namespace: "gmail", description: "Gmail (default)", namespaceStatus: "ready" },
      { namespace: "gmail", tool: "get_thread", description: "Get" },
      { namespace: "gmail", tool: "search_threads", description: "Search threads line2" },
    ]);
    expect(render({ namespace: "cursor", pattern: "send" }).matches.map((m: any) => m.tool)).toEqual(["SendToAgent"]);
    // A scoped pattern can legitimately match nothing in an existing namespace.
    expect(render({ namespace: "cursor", pattern: "browser_" })).toEqual({ mode: "search", pattern: "browser_", matches: [] });
  });

  test("lookup errors use the reference texts", () => {
    expect(() => discover({ toolName: "Computer" })).toThrow(new Error("toolName requires namespace to be set."));
    expect(() => discover({ pattern: "x".repeat(257) })).toThrow(new Error("pattern cannot exceed 256 characters."));
    expect(() => discover({ pattern: "(" })).toThrow(/^Invalid regex pattern: /);
    expect(() => discover({ namespace: "slack" })).toThrow(new DynamicLookupMiss('namespace "slack" not found. Available namespaces: cursor, gmail'));
    expect(() => discover({ namespace: "slack", pattern: "post" })).toThrow('namespace "slack" not found.');
    expect(() => discover({ namespace: "gmail", toolName: "send" })).toThrow(new DynamicLookupMiss('Tool "send" not found in namespace "gmail".'));
    expect(() => discover({ namespace: "cursor", toolName: "Shell" }, { directTools: ["Shell", "Read"] })).toThrow(
      'Tool "Shell" is already available directly and is not part of dynamic namespace "cursor". Invoke "Shell" directly instead of using dynamic tool discovery or invocation.'
    );
  });

  test("a call runs without a prior lookup and still validates its arguments", () => {
    const input: CallDynamicToolInput = { namespace: "cursor", toolName: "Computer", arguments: {} };
    expect(() => resolveDynamicTool(catalog(), input)).toThrow("action is required");
    expect(resolveDynamicTool(catalog(), { ...input, arguments: { action: "click" } }).arguments).toEqual({ action: "click" });
    expect(resolveDynamicTool(catalog(), { ...input, arguments: '{"action":"click"}' }).arguments).toEqual({ action: "click" });
    expect(() => resolveDynamicTool(catalog(), { ...input, arguments: "{action" })).toThrow(
      "Failed to parse arguments string as JSON object. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string."
    );
  });

  test("unknown tools and namespaces name what is available", () => {
    expect(() => resolveDynamicTool(catalog(), { namespace: "cursor", toolName: "Nope" })).toThrow(
      'Built-in tool "Nope" not found in namespace "cursor". Available tools: SendToAgent, Computer. Use GetDynamicTools to discover their schemas.'
    );
    expect(() => resolveDynamicTool(catalog(), { namespace: "slack", toolName: "post" })).toThrow(
      new DynamicLookupMiss("MCP server does not exist: slack. Available servers: gmail")
    );
    expect(() => resolveDynamicTool(catalog(), { namespace: "gmail", toolName: "send" })).toThrow(
      new DynamicLookupMiss("Tool send was not found. Use GetDynamicTools to discover available servers and their tools.")
    );
  });

  test("a namespace that is not ready shows no tools, says why, and tells the agent what to do", () => {
    const reason = "Local runtime unavailable: MCP process exited. Reconnect to try again.";
    const unavailable = catalog("error").map((namespace) => namespace.name === "gmail" ? { ...namespace, statusMessage: reason } : namespace);
    const input = { namespace: "gmail" };
    expect(renderDynamicDiscovery(discoverDynamicTools(unavailable, input), input)).toEqual({
      mode: "namespace", namespace: "gmail", namespaceStatus: "error",
      namespaceError: `This MCP server failed during live tool discovery. Its tools are unavailable until the connection is fixed. ${reason}`,
      namespaceDescription: "Gmail (default)", tools: [],
    });
    expect(() => discoverDynamicTools(catalog("needsAuth"), { namespace: "gmail", toolName: "get_thread" })).toThrow(
      new Error("This MCP server requires authentication before its tools can be used.")
    );
    const call = { namespace: "gmail", toolName: "get_thread", arguments: {} };
    expect(() => resolveDynamicTool(catalog("needsAuth"), call, { unavailableGuidance: (n) => `Call AuthenticateMcpServer with server_id "${n.name}".` })).toThrow(
      'This MCP server requires authentication before its tools can be used. Call AuthenticateMcpServer with server_id "gmail".'
    );
    // A ready namespace never carries a stale reason.
    const ready = catalog().map((namespace) => ({ ...namespace, statusMessage: reason }));
    expect(JSON.stringify(renderDynamicDiscovery(discoverDynamicTools(ready, input), input))).not.toContain(reason);
  });
});
