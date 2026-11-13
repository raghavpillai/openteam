// Tool calls through RuntimeTools: delivery, end_turn grace, reactions, argument and host errors, connector results.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { routeEvent } from "../../src/runtime/events";
import { untrustedResultsExtension } from "../../src/runtime/untrusted-results";
import { tempDirs } from "../temp";
import { controlPlane, runtimeTools, withFetch } from "./tool-fixtures";
const tempDir = tempDirs();

const attachment = { type: "attachment", url: "https://example.invalid/report.zip" };
/** A response that issued an attachment send ("zip"), before any of it runs. */
function delivery() {
  const f = controlPlane((_name, _args, id) => ({ sent: true, id }));
  const batch = (parts: any[]) => routeEvent(undefined, f.active, { type: "message_end", message: { role: "assistant", content: parts, stopReason: "toolUse" } } as any);
  const send = (id: string, args: any, signal?: AbortSignal) => f.call("SendToUser", args, id, signal);
  batch([{ type: "toolCall", name: "SendToUser", id: "zip", arguments: attachment }]);
  return { ...f, batch, send };
}
const interrupt = (active: any) => { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(new Error("interrupted by user")); };

test("closing text preserves an already-issued attachment, once, without allowing new work", async () => {
  const { active, calls, call, send, batch } = delivery();
  await send("summary", { type: "text", content: "Report attached", end_turn: true });
  expect(active.endTurnRequested).toBe(true);
  await expect(call("Shell", { command: "true" })).rejects.toThrow("turn has ended");
  await expect(send("new", attachment)).rejects.toThrow("turn has ended");
  await expect(send("zip", { ...attachment, url: "https://example.invalid/changed.zip" })).rejects.toThrow("turn has ended");
  await send("zip", attachment);
  await expect(send("zip", attachment)).rejects.toThrow("turn has ended");
  batch([{ type: "toolCall", name: "SendToUser", id: "later", arguments: attachment }]);
  await expect(send("later", attachment)).rejects.toThrow("turn has ended");
  expect(calls.map((x) => x.id)).toEqual(["summary", "zip"]);
});

for (const scenario of ["cancelled", "interrupted", "failed", "next-response"] as const) {
  test(`delivery grace respects ${scenario}`, async () => {
    const { active, calls, send, tools, batch } = delivery();
    if (scenario === "next-response") batch([]);
    await send("summary", { type: "text", content: "Done", end_turn: true });
    const controller = new AbortController();
    if (scenario === "cancelled") controller.abort(new Error("stopped"));
    if (scenario === "interrupted") interrupt(active);
    if (scenario === "failed") tools.callControlPlaneTool = async () => { throw new Error("delivery failed"); };
    await expect(send("zip", attachment, controller.signal)).rejects.toThrow();
    if (scenario === "failed") await expect(send("zip", attachment)).rejects.toThrow("turn has ended");
    expect(calls).toHaveLength(1);
  });
}

const stop = { namespace: "cursor", toolName: "StopSubagent", arguments: { subagent_id: "worker" } };
function cleanup() {
  const f = delivery();
  f.active.toolArgs = new Map();
  f.batch([{ type: "toolCall", name: "CallDynamicTool", id: "stop", arguments: stop }]);
  const execute = async (args = stop, id = "stop") => {
    routeEvent(undefined, f.active, { type: "tool_execution_start", toolName: "CallDynamicTool", toolCallId: id, args } as any);
    let result: any, isError = false;
    try { result = await f.call("CallDynamicTool", args, id); }
    catch (error) { isError = true; result = { isError: true }; throw error; }
    finally { routeEvent(undefined, f.active, { type: "tool_execution_end", toolName: "CallDynamicTool", toolCallId: id, result, isError } as any); }
    return result;
  };
  return { ...f, execute };
}

test("queued worker cleanup completes after closing text without creating another delivery obligation", async () => {
  const { active, send, execute, calls } = cleanup();
  await send("summary", { type: "text", content: "Done", end_turn: true });
  await execute();
  expect(active.failedResponseCalls).toEqual([]);
  expect(calls.map((c) => c.name)).toEqual(["SendToUser", "StopSubagent"]);
  await expect(execute()).rejects.toThrow("turn has ended");
});

for (const scenario of ["changed", "new", "failed", "interrupted", "later", "read-only"] as const) {
  test(`worker cleanup grace respects ${scenario}`, async () => {
    const { active, send, execute, tools, batch } = cleanup();
    await send("summary", { type: "text", content: "Done", end_turn: true });
    if (scenario === "interrupted") interrupt(active);
    if (scenario === "failed") tools.callControlPlaneTool = async () => { throw new Error("stop failed"); };
    if (scenario === "read-only") active.readOnly = true;
    if (scenario === "later") batch([{ type: "toolCall", name: "CallDynamicTool", id: "later", arguments: stop }]);
    await expect(execute(scenario === "changed" ? { ...stop, arguments: { subagent_id: "other" } } : stop,
      ["new", "later"].includes(scenario) ? scenario : "stop")).rejects.toThrow();
  });
}

test("queued cleanup rechecks cancel after mutation wait", async () => {
  const { active, send, execute, tools, calls } = cleanup();
  active.contextSessionId = "queued-fixture";
  let release!: () => void;
  tools.mutationTails.set(active.contextSessionId, new Promise<void>((resolve) => { release = resolve; }));
  await send("summary", { type: "text", content: "Done", end_turn: true });
  const pending = execute();
  active.pluginAbortController = new AbortController(); active.pluginAbortController.abort();
  release();
  await expect(pending).rejects.toThrow();
  expect(calls.map((c) => c.name)).toEqual(["SendToUser"]);
});

test("every main-agent tool runs in parallel; only graphical controls stay sequential", () => {
  const tools = runtimeTools();
  const base = { requestSource: "turn", subagentType: null, readOnly: false, pluginRuntimePackages: [], pluginNamespaces: [] };
  const main = tools.customTools(base);
  expect(main.map((tool: any) => tool.name)).toContain("SendToUser");
  expect(main.filter((tool: any) => tool.executionMode !== "parallel")).toEqual([]);
  const graphical = tools.customTools({ ...base, subagentType: "computerUse" });
  expect(graphical.filter((tool: any) => tool.executionMode === "sequential").map((tool: any) => tool.name)).toContain("Computer");
  expect(graphical.find((tool: any) => tool.name === "Shell").executionMode).toBe("parallel");
});

test("an ack goes out at once beside other calls, and sends of one response keep call order", async () => {
  const { active, tools } = delivery();
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  tools.callControlPlaneTool = async (_turn: any, id: string) => {
    order.push(`start:${id}`);
    await new Promise<void>((resolve) => releases.set(id, resolve));
    order.push(`end:${id}`);
    return { content: [{ type: "text", text: "ok" }], details: {} };
  };
  const ack = tools.executeOpenTeamTool(active, "ack", "SendToUser", { type: "text", content: "On it" });
  const second = tools.executeOpenTeamTool(active, "second", "SendToUser", { type: "text", content: "Found it" });
  const work = tools.executeOpenTeamTool(active, "work", "RecallMemory", { query: "tea" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Both run at once; the second send waits for the first.
  expect([...order].sort()).toEqual(["start:ack", "start:work"]);
  releases.get("work")!();
  await work;
  releases.get("ack")!();
  await ack;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order.slice(2)).toEqual(["end:work", "end:ack", "start:second"]);
  releases.get("second")!();
  await second;
});

test("SendToUser through CallDynamicTool keeps call order with native sends and names a failed send", async () => {
  const { tools, active, call } = controlPlane(() => Response.json({ error: { code: "reply_target_not_found", message: "The reply target was not found" } }, { status: 404 }));
  await expect(call("CallDynamicTool", { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "hi", reply_to: "t9u" } })).rejects.toThrow(
    /^Error: Failed to send the message to the user: The reply target was not found$/
  );
  const delivered: string[] = [];
  tools.callControlPlaneTool = async (_turn: any, _id: string, _name: string, args: any) => {
    if (args.content === "first") await Bun.sleep(50);
    delivered.push(args.content);
    return { content: [{ type: "text", text: "Sent" }], details: {} };
  };
  active.sendChain = undefined;
  await Promise.all([
    call("SendToUser", { type: "text", content: "first" }),
    call("CallDynamicTool", { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "second" } }),
  ]);
  expect(delivered).toEqual(["first", "second"]);
});

// Reactions
const reactions = (response: (name: string) => unknown) => controlPlane((name) => response(name), { userAcknowledged: false });

test("a reaction with end_turn is the whole reply: it counts as delivery and ends the turn", async () => {
  const { active, calls, call } = reactions(() => ({ reacted: true, removed: false }));
  const result = await call("ReactToMessage", { message_address: "t3u", emoji: "👍", end_turn: true });
  expect(result.terminate).toBe(true);
  expect(result.content[0].text).toBe("Reacted 👍 on t3u. (Reactions toggle: react the same emoji again to take it back.)");
  expect(active).toMatchObject({ endTurnRequested: true, sentMessageCount: 1 });
  expect(calls[0]!.args).toMatchObject({ end_turn: true });
  await expect(call("Shell", { command: "true" })).rejects.toThrow("turn has ended");
});

test("a reaction without end_turn acknowledges the user while allowing background work to continue", async () => {
  const { active, call } = reactions((name) => name === "ReactToMessage" ? { reacted: true, removed: false } : { sent: true });
  const result = await call("ReactToMessage", { message_address: "t3u", emoji: "👍" });
  expect(result.terminate).toBeUndefined();
  expect(active.endTurnRequested).toBeUndefined();
  expect(active).toMatchObject({ sentMessageCount: 1, userAcknowledged: true });
  await call("SendToUser", { type: "text", content: "The result is 391.", end_turn: true });
  expect(active).toMatchObject({ endTurnRequested: true, sentMessageCount: 2 });
});

for (const type of ["attachment", "widget"] as const) test(`a delivered ${type} is output but is not an opening acknowledgement`, async () => {
  const { active, call } = reactions(() => ({ sent: true }));
  Object.assign(active, { requestSource: "turn", subagentType: null });
  const args = type === "attachment"
    ? { type, url: "https://example.invalid/result.txt" }
    : { type, widget: { prompt: "Continue?", options: [{ label: "Yes", value: "yes" }] } };
  await call("SendToUser", args, "send");
  // Counts as output, but the reminder to acknowledge still applies (see prompt-context).
  expect(active).toMatchObject({ sentMessageCount: 1, userAcknowledged: false });
});

test("an invalid or failed reaction cannot discharge the delivery obligation or end the turn", async () => {
  for (const response of [{ reacted: false, removed: false }, { error: { message: "not visible" } }]) {
    const { active, call } = reactions(() => response);
    await call("ReactToMessage", { message_address: "t9u", emoji: "👍", end_turn: "error" in response }).catch(() => undefined);
    expect(active).toMatchObject({ sentMessageCount: 0, userAcknowledged: false });
    expect(active.endTurnRequested).toBeUndefined();
  }
});

// Argument and tool-host errors
test("SendToUser failures name the send and give the reason, not an error envelope", async () => {
  const { call } = controlPlane(() => Response.json({ error: { code: "reply_target_not_found", message: "The reply target was not found" } }, { status: 404 }));
  await expect(call("SendToUser", { type: "text", content: "hi", reply_to: "t9u" })).rejects.toThrow(/^Failed to send the message to the user: The reply target was not found$/);
  await expect(call("SendToUser", { type: "text" })).rejects.toThrow(/^Failed to send the message to the user: Invalid arguments:\ncontent: content is required when type is text$/);
  await expect(call("SendToUser", { type: "text", content: "hi", attachments: [{ url: "file:///workspace/a.pdf" }] })).rejects.toThrow(
    "Failed to send the message to the user: Invalid arguments:\nattachments: attachments is not a SendToUser field"
  );
  // A missing attachment is named before anything reaches the tool host.
  const untouched = withFetch(async () => { throw new Error("the tool host must not be called"); }, () =>
    runtimeTools().executeOpenTeamTool({ runId: "fixture", botId: "fixture", runtimeProfile: "agent", pluginNamespaces: [] }, "call", "SendToUser", { type: "attachment", url: "file:///tmp/openteam-missing-deliverable.pdf" }));
  await expect(untouched).rejects.toThrow(/^Failed to send the message to the user: No file at \/tmp\/openteam-missing-deliverable\.pdf on your box, so nothing was sent\./);
});

const lookup = (f: ReturnType<typeof controlPlane>, toolName: string, args: any) => f.call("CallDynamicTool", { namespace: "cursor", toolName, arguments: args });

test("first-party lookups coerce string-encoded values and report decode failures per field", async () => {
  const f = controlPlane(() => ({ stopped_all: true, stopped: [], already_finished: [], failed: [] }));
  await lookup(f, "StopSubagent", { all: "true" });
  expect(f.calls[0]).toMatchObject({ name: "StopSubagent", args: { all: true } });
  await expect(lookup(f, "Task", { description: "x", subagent_type: "executor" })).rejects.toThrow(/^Error: Invalid arguments:\nprompt: /);
  await expect(lookup(f, "UpdateAgent", { name: "x" })).rejects.toThrow(/^Error: Invalid arguments:\nagent_id: Invalid input: expected string, received undefined$/);
});

test("DraftExternalMessage argument problems are named per field and a lone recipient is a list", async () => {
  const f = controlPlane(() => ({ sent: true, message_id: "m1" }));
  const draft = { platform: "email", providerIdentifier: "gmail", subject: "Hi", body: "Hello" };
  await expect(lookup(f, "DraftExternalMessage", { ...draft, to: ["ann@example.com"] })).rejects.toThrow(/^Error: Invalid arguments:\nfrom: from is required when platform is email$/);
  const result = await lookup(f, "DraftExternalMessage", { ...draft, from: "me@example.com", to: "ann@example.com" });
  expect(f.calls.at(-1)).toMatchObject({ name: "DraftExternalMessage", args: { to: ["ann@example.com"] } });
  expect(result.content[0].text).toStartWith("Draft email from me@example.com to ann@example.com is now an editable card in the chat (id: m1).");
});

test("control-plane failures surface the server's message, not its JSON envelope", async () => {
  const { tools, active } = controlPlane();
  const failWith = (status: number, body: string, tool: string) =>
    withFetch(async () => new Response(body, { status }), () => tools.callControlPlaneToolRequest(active, "call", tool, {}));
  await expect(failWith(404, JSON.stringify({ error: { code: "subagent_not_running", message: "That subagent is not running." } }), "MessageSubagent")).rejects.toThrow(new Error("That subagent is not running."));
  await expect(failWith(500, JSON.stringify({ error: { code: "internal_error", message: "\nInvalid `prisma.run.findUnique()` invocation: Can't reach database server" } }), "CheckSubagent")).rejects.toThrow(new Error("Couldn't finish due to a temporary server issue."));
  await expect(failWith(502, "<html>Bad gateway</html>", "CheckSubagent")).rejects.toThrow(new Error("Couldn't finish due to a temporary server issue."));
  await expect(failWith(500, JSON.stringify({ error: { code: "internal_error", message: "MCP error -32603: upstream exploded" } }), "PluginCall")).rejects.toMatchObject({ message: "MCP error -32603: upstream exploded", code: "internal_error" });
});

test("a connector call is cut off by the 840-second guard with the reference text", async () => {
  const { tools, active } = controlPlane();
  expect(tools.toolCallTimeoutMs).toBe(840_000);
  tools.toolCallTimeoutMs = 20;
  const hang = (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  await withFetch(hang, async () => {
    await expect(tools.callControlPlaneToolRequest(active, "call", "PluginCall", { connectionId: "c", toolName: "get_call", arguments: { wait_seconds: 30 } }))
      .rejects.toThrow("The CallDynamicTool tool call timed out after 0 seconds and was terminated. The execution environment may be unresponsive, or the operation needs longer than the per-call time limit.");
    await expect(tools.callControlPlaneToolRequest(active, "send", "SendToUser", { type: "text", content: "hi" })).rejects.toThrow("The SendToUser tool call timed out");
    // A turn stop is not a timeout.
    const stopper = new AbortController();
    const stopped = tools.callControlPlaneToolRequest(active, "stop", "PluginCall", {}, stopper.signal);
    stopper.abort(new Error("stopped"));
    await expect(stopped).rejects.toThrow("stopped");
  });
});

// Connector results
async function pluginCall(body: unknown, cwd = "/tmp"): Promise<any> {
  const { tools, active } = controlPlane(() => body, { cwd });
  return withFetch(async () => Response.json(body), () =>
    tools.callControlPlaneToolRequest(active, "call", "PluginCall", { connectionId: "c", namespace: "plugin_c", toolName: "get_slide_thumbnail", arguments: {} }));
}

test("plugin MCP image content reaches the model as image parts, not base64 text", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
  const content = [{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "{\"pageObjectId\":\"p\",\"width\":800,\"height\":450}" }];
  expect((await pluginCall({ content })).content).toEqual(content);
});

test("connector text reaches the model verbatim, without the MCP envelope or structuredContent", async () => {
  const text = "{\"threads\":[{\"id\":\"18f1\",\"snippet\":\"Lunch \\\"Thursday\\\"?\\nSee you\"}]}";
  const result = await pluginCall({ content: [{ type: "text", text }], structuredContent: JSON.parse(text), isError: false });
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.details.isError).toBeUndefined();
  const resource = { type: "resource_link", uri: "file:///a.txt", name: "a" };
  expect((await pluginCall({ content: [resource] })).content).toEqual([{ type: "text", text: JSON.stringify(resource) }]);
  expect((await pluginCall({ content: [], structuredContent: { ok: true } })).content).toEqual([{ type: "text", text: "{\"ok\":true}" }]);
});

test("a connector's isError result is flagged as a tool error with its own text", async () => {
  const result = await pluginCall({ content: [{ type: "text", text: "Google API 404: Requested entity was not found." }], isError: true });
  expect(result.content).toEqual([{ type: "text", text: "Google API 404: Requested entity was not found." }]);
  expect(result.details.isError).toBe(true);
  const handlers = new Map<string, Function>();
  untrustedResultsExtension().factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
  expect(await handlers.get("tool_result")!({ details: result.details })).toEqual({ isError: true });
  expect(await handlers.get("tool_result")!({ details: { tool: "PluginCall" } })).toBeUndefined();
});

test("connector text over 40 KB is written to a file and the model gets the reference pointer", async () => {
  const cwd = await tempDir("connector-spill-");
  const big = Array.from({ length: 1000 }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n");
  const png = Buffer.from([1, 2, 3]).toString("base64");
  const result = await pluginCall({ content: [{ type: "text", text: big }, { type: "image", data: png, mimeType: "image/png" }, { type: "text", text: "tail" }] }, cwd);
  expect(result.content).toHaveLength(2);
  expect(result.content[0].text).toMatch(new RegExp(`^Large output has been written to: ${cwd}/agent-tools/[0-9a-f-]{36}\\.txt \\(\\d+\\.\\d KB, 1002 lines\\)$`));
  expect(result.content[1]).toEqual({ type: "image", data: png, mimeType: "image/png" });
  expect(await readFile(result.details.outputPath, "utf8")).toBe(`${big}\n\ntail`);
  // Just at the limit stays inline.
  expect((await pluginCall({ content: [{ type: "text", text: "y".repeat(40_000) }] }, cwd)).content[0].text).toBe("y".repeat(40_000));
});
