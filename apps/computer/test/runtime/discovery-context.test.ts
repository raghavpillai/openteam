import { expect, test } from "bun:test";
import type { BotMessage } from "../../src/bot-compaction";
import { compactRepeatedDiscovery } from "../../src/runtime/discovery-context";
import { retainedDynamicTools } from "../../src/dynamic-tool-gateway";

const description = "Full authoritative tool description. ".repeat(30);
const descriptor = { tool: "ListGroups", description, inputSchema: { type: "object", properties: {} } };
const catalog: any[] = [{ name: "cursor", namespaceStatus: "ready", tools: [{
  name: descriptor.tool, description, inputSchema: descriptor.inputSchema,
}] }];
function pair(id: string, args: Record<string, unknown> = { namespace: "cursor", toolName: "ListGroups" }, result: unknown = descriptor): BotMessage[] {
  return [
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "GetDynamicTools", arguments: args }] },
    { role: "toolResult", toolName: "GetDynamicTools", toolCallId: id, isError: false, content: [{ type: "text", text: JSON.stringify(result) }] },
  ];
}
test("exact repeated schemas shrink while discovery authorization and original receipts remain", () => {
  const original = [...pair("first"), ...pair("second")];
  const before = structuredClone(original);
  const projected = compactRepeatedDiscovery(original);
  expect(projected[1]).toBe(original[1]);
  expect(JSON.stringify(projected[3])).toContain('schemaSourceToolCallId');
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(original).length);
  expect(retainedDynamicTools(catalog, projected)).toEqual(new Set(["cursor/ListGroups"]));
  expect(original).toEqual(before);
  expect(compactRepeatedDiscovery(projected)).toEqual(projected);
});
test("compaction removing the first receipt makes the surviving receipt complete again", () => {
  const original = [...pair("first"), ...pair("second"), ...pair("third")];
  compactRepeatedDiscovery(original);
  const projected = compactRepeatedDiscovery(original.slice(2));
  expect(projected[1]).toEqual(original[3]);
  expect(JSON.parse((projected[3]!.content as Array<{ text: string }>)[0]!.text).schemaSourceToolCallId).toBe("second");
  expect(retainedDynamicTools(catalog, projected).has("cursor/ListGroups")).toBe(true);
});
test("changed schemas, descriptions and namespaces remain full", () => {
  for (const changed of [
    { ...descriptor, description: description + "Changed" },
    { ...descriptor, inputSchema: { type: "object", required: ["id"] } },
  ]) {
    const original = [...pair("first"), ...pair("changed", undefined, changed)];
    expect(compactRepeatedDiscovery(original)).toEqual(original);
  }
  const original = [...pair("first"), ...pair("other", { namespace: "other", toolName: "ListGroups" })];
  expect(compactRepeatedDiscovery(original)).toEqual(original);
});
test("errors, orphaned results, summaries, images and searches never become schema references", () => {
  const variants = [
    pair("error").map((m) => m.role === "toolResult" ? { ...m, isError: true } : m),
    pair("orphan").slice(1),
    pair("search", { namespace: "cursor", pattern: "List.*" }),
    pair("summary", undefined, { ...descriptor, inputSchema: undefined }),
    pair("image").map((m) => m.role === "toolResult" ? { ...m, content: [...m.content as any[], { type: "image", data: "fixture", mimeType: "image/png" }] } : m),
  ];
  for (const variant of variants) {
    const original = [...pair("first"), ...variant] as BotMessage[];
    expect(compactRepeatedDiscovery(original)).toEqual(original);
  }
});
test("namespace lookups require the entire result to match", () => {
  const args = { namespace: "cursor" };
  const result = { mode: "namespace", namespace: "cursor", tools: [descriptor] };
  const original = [...pair("first", args, result), ...pair("second", args, result)];
  expect(JSON.stringify(compactRepeatedDiscovery(original)[3])).toContain('schemaSourceToolCallId');
  const unavailable = [...pair("first", args, result), ...pair("second", args, { ...result, namespaceStatus: "needsAuth" })];
  expect(compactRepeatedDiscovery(unavailable)).toEqual(unavailable);
});
