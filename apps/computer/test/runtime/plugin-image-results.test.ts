import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTools } from "../../src/runtime/tools";
import { spillConnectorText } from "../../src/runtime/connector-results";
import { untrustedResultsExtension } from "../../src/runtime/untrusted-results";

async function pluginCall(body: unknown, cwd = "/tmp") {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {runId: "fixture", botId: "fixture", screenBotId: "fixture", cwd, sentMessageCount: 0, pendingSteers: [], queue: {push() {}}};
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json(body)) as any;
    return await tools.callControlPlaneToolRequest(active, "call", "PluginCall", {connectionId: "c", namespace: "plugin_c", toolName: "get_slide_thumbnail", arguments: {}});
  } finally { globalThis.fetch = originalFetch; }
}

test("plugin MCP image content reaches the model as image parts, not base64 text", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
  const result = await pluginCall({content: [{type: "image", data: png, mimeType: "image/png"}, {type: "text", text: "{\"pageObjectId\":\"p\",\"width\":800,\"height\":450}"}]});
  expect(result.content).toEqual([
    {type: "image", data: png, mimeType: "image/png"},
    {type: "text", text: "{\"pageObjectId\":\"p\",\"width\":800,\"height\":450}"},
  ]);
});

test("connector text reaches the model verbatim, without the MCP envelope or structuredContent", async () => {
  const text = "{\"threads\":[{\"id\":\"18f1\",\"snippet\":\"Lunch \\\"Thursday\\\"?\\nSee you\"}]}";
  const result = await pluginCall({content: [{type: "text", text}], structuredContent: JSON.parse(text), isError: false});
  expect(result.content).toEqual([{type: "text", text}]);
  expect(result.details.isError).toBeUndefined();
  const resource = {type: "resource_link", uri: "file:///a.txt", name: "a"};
  expect((await pluginCall({content: [resource]})).content).toEqual([{type: "text", text: JSON.stringify(resource)}]);
  expect((await pluginCall({content: [], structuredContent: {ok: true}})).content).toEqual([{type: "text", text: "{\"ok\":true}"}]);
});

test("a connector's isError result is flagged as a tool error with its own text", async () => {
  const result = await pluginCall({content: [{type: "text", text: "Google API 404: Requested entity was not found."}], isError: true});
  expect(result.content).toEqual([{type: "text", text: "Google API 404: Requested entity was not found."}]);
  expect(result.details.isError).toBe(true);
  const handlers = new Map<string, Function>();
  untrustedResultsExtension().factory({on: (name: string, handler: Function) => handlers.set(name, handler)} as any);
  expect(await handlers.get("tool_result")!({details: result.details})).toEqual({isError: true});
  expect(await handlers.get("tool_result")!({details: {tool: "PluginCall"}})).toBeUndefined();
});

test("connector text over 40 KB is written to a file and the model gets the reference pointer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "connector-spill-"));
  try {
    const big = Array.from({length: 1000}, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n");
    const png = Buffer.from([1, 2, 3]).toString("base64");
    const result = await pluginCall({content: [{type: "text", text: big}, {type: "image", data: png, mimeType: "image/png"}, {type: "text", text: "tail"}]}, cwd);
    expect(result.content).toHaveLength(2);
    const pointer = result.content[0].text as string;
    expect(pointer).toMatch(new RegExp(`^Large output has been written to: ${cwd}/agent-tools/[0-9a-f-]{36}\\.txt \\(\\d+\\.\\d KB, 1002 lines\\)$`));
    expect(result.content[1]).toEqual({type: "image", data: png, mimeType: "image/png"});
    expect(await readFile(result.details.outputPath, "utf8")).toBe(`${big}\n\ntail`);
    // Just at the limit stays inline.
    const inline = await pluginCall({content: [{type: "text", text: "y".repeat(40_000)}]}, cwd);
    expect(inline.content[0].text).toBe("y".repeat(40_000));
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test("a failed spill keeps a 40 KB head with the reference truncation notice", async () => {
  const text = "z".repeat(50_000);
  const { parts } = await spillConnectorText([{type: "text", text}], "/nonexistent", async () => { throw new Error("disk full"); });
  const inline = (parts[0] as {text: string}).text;
  expect(Buffer.byteLength(inline)).toBeLessThanOrEqual(40_000);
  expect(inline).toEndWith("\n\n[Output truncated: the full MCP tool output was 50000 bytes, which exceeds the inline limit of 40000 bytes, and could not be written to a file. The remainder was discarded; do not retry the same call expecting the full output.]");
});
