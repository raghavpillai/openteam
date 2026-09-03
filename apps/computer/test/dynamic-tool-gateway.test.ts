import { describe, expect, test } from "bun:test";
import type { CallDynamicToolInput, GetDynamicToolsInput } from "@openteam/contracts";
import {
  type DynamicNamespaceDefinition,
  discoverDynamicTools,
  resolveDynamicTool,
} from "../src/dynamic-tool-gateway";

const longDescription = "x".repeat(240);

const catalog = (
  status: DynamicNamespaceDefinition["namespaceStatus"] = "ready"
): DynamicNamespaceDefinition[] => [
  {
    name: "openteam",
    description: "First-party OpenTeam tools",
    kind: "first-party",
    namespaceStatus: status,
    tools: [
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
      {
        name: "SendToAgent",
        description: "Send a message to another agent",
        inputSchema: { type: "object" },
        source: "first-party",
        decodeArguments: (input) => input,
      },
    ],
  },
];

const discover = (receipts: Set<string>, input: GetDynamicToolsInput = {}) =>
  discoverDynamicTools(catalog(), receipts, input);

describe("OpenTeam dynamic tool gateway", () => {
  test("catalog discovery returns schemas, truncates descriptions, and records receipts", () => {
    const receipts = new Set<string>();
    const result = discover(receipts);

    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces[0]?.tools[0]?.description).toBe(`${"x".repeat(200)}... [truncated]`);
    expect(result.namespaces[0]?.tools[0]?.inputSchema).toEqual(
      catalog()[0]?.tools[0]?.inputSchema
    );
    expect(receipts).toEqual(new Set(["openteam/Computer", "openteam/SendToAgent"]));
  });

  test("exact lookup returns the complete descriptor", () => {
    const receipts = new Set<string>();
    const result = discover(receipts, { namespace: "openteam", toolName: "Computer" });

    expect(result.namespaces[0]?.tools).toHaveLength(1);
    expect(result.namespaces[0]?.tools[0]?.description).toBe(longDescription);
    expect(receipts).toEqual(new Set(["openteam/Computer"]));
  });

  test("search can match a namespace or a tool name", () => {
    const namespaceMatch = discover(new Set(), { pattern: "openteam" });
    const toolMatch = discover(new Set(), { namespace: "openteam", pattern: "send" });

    expect(namespaceMatch.namespaces[0]?.tools).toHaveLength(2);
    expect(toolMatch.namespaces[0]?.tools.map((tool) => tool.name)).toEqual(["SendToAgent"]);
  });

  test("rejects malformed discovery requests", () => {
    expect(() => discover(new Set(), { toolName: "Computer" })).toThrow(
      "toolName requires namespace"
    );
    expect(() => discover(new Set(), { pattern: "[" })).toThrow("Invalid tool search pattern");
    expect(() => discover(new Set(), { namespace: "missing" })).toThrow(
      "Dynamic namespace or tool not found"
    );
  });

  test("requires discovery and validates nested arguments before dispatch", () => {
    const receipts = new Set<string>();
    const input: CallDynamicToolInput = {
      namespace: "openteam",
      toolName: "Computer",
      arguments: {},
    };

    expect(() => resolveDynamicTool(catalog(), receipts, input)).toThrow("Call GetDynamicTools");

    discover(receipts, { namespace: "openteam", toolName: "Computer" });
    expect(() => resolveDynamicTool(catalog(), receipts, input)).toThrow("action is required");
    expect(
      resolveDynamicTool(catalog(), receipts, {
        ...input,
        arguments: { action: "click" },
      }).arguments
    ).toEqual({ action: "click" });
  });

  test("rechecks namespace status and rejects MCP metadata for first-party tools", () => {
    const receipts = new Set(["openteam/Computer"]);
    const input: CallDynamicToolInput = {
      namespace: "openteam",
      toolName: "Computer",
      arguments: { action: "click" },
    };

    expect(() => resolveDynamicTool(catalog("needsAuth"), receipts, input)).toThrow(
      "unavailable (needsAuth)"
    );
    expect(() => resolveDynamicTool(catalog(), receipts, { ...input, mcpDetails: {} })).toThrow(
      "mcpDetails must be omitted"
    );
  });
});
