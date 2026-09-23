import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { discoverDynamicTools, renderDynamicDiscovery, retainedDynamicTools, resolveDynamicTool, type DynamicNamespaceDefinition } from "../../src/dynamic-tool-gateway";
import type { BotMessage } from "../../src/compaction/types";

const catalog: DynamicNamespaceDefinition[] = [{ name: "fixture", description: "Fixture", kind: "mcp", namespaceStatus: "ready", tools: [{ name: "ReadValue", description: "Read a fixture value", source: "fixture", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, decodeArguments: args => {
  if (typeof (args as any).key !== "string") throw new Error("key required");
  return args;
} }] }];
const call = { namespace: "fixture", toolName: "ReadValue", arguments: { key: "answer" } };
const history = (input: any = { namespace: "fixture", toolName: "ReadValue" }): BotMessage[] => [
  { role: "assistant", content: [{ type: "toolCall", id: "lookup", name: "GetDynamicTools", arguments: input }], stopReason: "toolUse" },
  { role: "toolResult", toolCallId: "lookup", toolName: "GetDynamicTools", isError: false, content: [{ type: "text", text: JSON.stringify(renderDynamicDiscovery(discoverDynamicTools(catalog, new Set(), input), input)) }] },
];

describe("retained dynamic discovery", () => {
  test("a reopened durable session can reuse an unchanged full descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "discovery-reuse-"));
    try {
      const manager = SessionManager.create(root, root);
      manager.appendMessage({ role: "user", content: "Read the fixture", timestamp: Date.now() });
      for (const message of history()) manager.appendMessage(message as any);
      const reopened = SessionManager.open(manager.getSessionFile()!, root, root);
      const messages = reopened.buildSessionContext().messages as BotMessage[];
      // This is the old turn boundary: schemas persisted but the receipt set reset.
      expect(() => resolveDynamicTool(catalog, new Set(), call)).toThrow("Call GetDynamicTools");
      expect(resolveDynamicTool(catalog, retainedDynamicTools(catalog, messages), call).arguments).toEqual({ key: "answer" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("namespace lookups qualify; searches, catalogs and spooled stubs do not", () => {
    expect(retainedDynamicTools(catalog, history({ namespace: "fixture" })).size).toBe(1);
    for (const input of [{}, { pattern: "ReadValue" }, { namespace: "fixture", pattern: "ReadValue" }]) {
      expect(retainedDynamicTools(catalog, history(input)).size).toBe(0);
    }
    const messages = history();
    messages[1]!.content = [{ type: "text", text: "Output written to /workspace/tools.json" }];
    expect(retainedDynamicTools(catalog, messages).size).toBe(0);
  });

  test("compacted, failed, orphaned or spoofed results do not count", () => {
    const messages = history();
    for (const candidate of [[], messages.slice(1), [{ ...messages[0], role: "user" }, messages[1]!], [messages[0]!, { ...messages[1], isError: true }], [{ role: "custom", content: JSON.stringify(messages) }]]) {
      expect(retainedDynamicTools(catalog, candidate).size).toBe(0);
    }
    expect(retainedDynamicTools(catalog, [messages[0]!, { ...messages[1], toolCallId: "other" }]).size).toBe(0);
  });

  test("schema, description, availability and effective catalog are rechecked", () => {
    const changedSchema = [{ ...catalog[0]!, tools: [{ ...catalog[0]!.tools[0]!, inputSchema: { type: "object" } }] }];
    const changedDescription = [{ ...catalog[0]!, tools: [{ ...catalog[0]!.tools[0]!, description: "Changed behavior" }] }];
    for (const current of [[], changedSchema, changedDescription, [{ ...catalog[0]!, namespaceStatus: "needsAuth" as const }]]) {
      expect(retainedDynamicTools(current, history()).size).toBe(0);
    }
    const receipts = retainedDynamicTools(catalog, history());
    expect(() => resolveDynamicTool(catalog, receipts, { ...call, arguments: {} })).toThrow("key required");
    expect(() => resolveDynamicTool([{ ...catalog[0]!, namespaceStatus: "error" }], receipts, call)).toThrow("unavailable");
  });

  test("runtime dispatch reuses retained schemas but still invokes the ordinary tool executor", async () => {
    const tools = (new ComputerRuntime() as any).tools;
    let invocations = 0;
    let reviews = 0;
    let denied = false;
    tools.nativeToolExecutor.autoReviewAction = async () => {
      reviews++;
      if (denied) throw new Error("Fixture review denied");
      return { allowed: true };
    };
    tools.dynamicCatalog = () => [{ ...catalog[0], tools: [{ ...catalog[0]!.tools[0], execute: async () => {
      invocations++; return { content: [{ type: "text", text: "42" }], details: {} };
    } }] }];
    const active: any = { contextSessionId: "reuse-fixture", discoveredDynamicTools: new Set(), dynamicDiscoveryMessages: history() };
    expect(await tools.callDynamicTool(active, "invoke", call)).toMatchObject({ content: [{ text: "42" }] });
    expect(invocations).toBe(1);
    expect(reviews).toBe(1);
    denied = true;
    await expect(tools.callDynamicTool(active, "denied", call)).rejects.toThrow("Fixture review denied");
    expect(reviews).toBe(2);
    expect(invocations).toBe(1);
    active.dynamicDiscoveryMessages = [];
    await expect(tools.callDynamicTool(active, "compacted", call)).rejects.toThrow("Call GetDynamicTools");
    expect(invocations).toBe(1);
  });
});
