import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import { routeEvent } from "../../src/runtime/events";

const attachment = {type: "attachment", url: "https://example.invalid/report.zip"};
function fixture() {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {runId: "fixture", botId: "fixture", screenBotId: "fixture", sentMessageCount: 0, pendingSteers: [], queue: {push() {}}};
  const calls: any[] = [];
  // Keep the real delivery response handling; only replace the transport/staging.
  tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { calls.push({id, name, args}); return Response.json({sent: true, id}); }) as any;
      return await tools.callControlPlaneToolRequest(turn, id, name, args);
    } finally { globalThis.fetch = originalFetch; }
  };
  const batch = (parts: any[]) => routeEvent(undefined, active, {type: "message_end", message: {role: "assistant", content: parts, stopReason: "toolUse"}} as any);
  const call = (id: string, args: any, name = "SendToUser", signal?: AbortSignal) => tools.executeOpenTeamTool(active, id, name, args, signal);
  batch([{type: "toolCall", name: "SendToUser", id: "zip", arguments: attachment}]);
  return {active, calls, call, batch, tools};
}

test("closing text preserves an already-issued attachment, once, without allowing new work", async () => {
  const {active, calls, call, batch} = fixture();
  await call("summary", {type: "text", content: "Report attached", end_turn: true});
  expect(active.endTurnRequested).toBe(true);
  await expect(call("shell", {command: "true"}, "Shell")).rejects.toThrow("turn has ended");
  await expect(call("new", attachment)).rejects.toThrow("turn has ended");
  await expect(call("zip", {...attachment, url: "https://example.invalid/changed.zip"})).rejects.toThrow("turn has ended");
  await call("zip", attachment);
  await expect(call("zip", attachment)).rejects.toThrow("turn has ended");
  batch([{type: "toolCall", name: "SendToUser", id: "later", arguments: attachment}]);
  await expect(call("later", attachment)).rejects.toThrow("turn has ended");
  expect(calls.map(x => x.id)).toEqual(["summary", "zip"]);
});

for (const scenario of ["cancelled", "steered", "widget", "failed", "next-response"] as const) {
  test(`delivery grace respects ${scenario}`, async () => {
    const {active, calls, call, tools, batch} = fixture();
    if (scenario === "next-response") batch([]);
    if (scenario === "widget") await tools.callControlPlaneTool(active, "summary", "SendToUser", {type: "widget"});
    else await call("summary", {type: "text", content: "Done", end_turn: true});
    const controller = new AbortController();
    if (scenario === "cancelled") controller.abort(new Error("stopped"));
    if (scenario === "steered") active.pendingSteers.push({content: "stop"});
    if (scenario === "failed") tools.callControlPlaneTool = async () => {throw new Error("delivery failed");};
    await expect(call("zip", attachment, "SendToUser", controller.signal)).rejects.toThrow();
    if (scenario === "failed") await expect(call("zip", attachment)).rejects.toThrow("turn has ended");
    expect(calls).toHaveLength(1);
  });
}

const stop = {namespace: "cursor", toolName: "StopSubagent", arguments: {subagent_id: "worker"}};
function cleanupFixture() {
  const f = fixture();
  Object.assign(f.active, {toolArgs: new Map(), pluginNamespaces: [], discoveredDynamicTools: new Set(["cursor/StopSubagent"])});
  f.batch([{type: "toolCall", name: "CallDynamicTool", id: "stop", arguments: stop}]);
  const execute = async (args = stop, id = "stop") => {
    routeEvent(undefined, f.active, {type: "tool_execution_start", toolName: "CallDynamicTool", toolCallId: id, args} as any);
    let result: any, isError = false;
    try { result = await f.call(id, args, "CallDynamicTool"); }
    catch (error) { isError = true; result = {isError: true}; throw error; }
    finally { routeEvent(undefined, f.active, {type: "tool_execution_end", toolName: "CallDynamicTool", toolCallId: id, result, isError} as any); }
    return result;
  };
  return {...f, execute};
}

test("queued worker cleanup completes after closing text without creating another delivery obligation", async () => {
  const {active, call, execute, calls} = cleanupFixture();
  await call("summary", {type: "text", content: "Done", end_turn: true});
  const result = await execute();
  expect(result.details.deliveryCleanup).toBe(true);
  expect(active.toolActivityAfterLastSend).toBe(false);
  expect(calls.map(c => c.name)).toEqual(["SendToUser", "StopSubagent"]);
  await expect(execute()).rejects.toThrow("turn has ended");
  expect(active.toolActivityAfterLastSend).toBe(true);
});

for (const scenario of ["changed", "new", "failed", "cancelled", "steered", "widget", "later", "prior-activity", "undiscovered", "read-only"] as const) {
  test(`worker cleanup grace respects ${scenario}`, async () => {
    const {active, call, execute, tools, batch} = cleanupFixture();
    if (scenario === "widget") await tools.callControlPlaneTool(active, "summary", "SendToUser", {type: "widget"});
    else await call("summary", {type: "text", content: "Done", end_turn: true});
    if (scenario === "failed") tools.callControlPlaneTool = async () => {throw new Error("stop failed");};
    if (scenario === "steered") active.pendingSteers.push({content: "new instruction"});
    if (scenario === "cancelled") { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(); }
    if (scenario === "undiscovered") active.discoveredDynamicTools.clear();
    if (scenario === "read-only") active.readOnly = true;
    if (scenario === "later") batch([{type: "toolCall", name: "CallDynamicTool", id: "later", arguments: stop}]);
    if (scenario === "prior-activity") {
      active.toolActivityAfterLastSend = true;
      await execute();
    } else {
      await expect(execute(scenario === "changed" ? {...stop, arguments: {subagent_id: "other"}} : stop,
        ["new", "later"].includes(scenario) ? scenario : "stop")).rejects.toThrow();
    }
    expect(active.toolActivityAfterLastSend).toBe(true);
  });
}

for (const reason of ["steer", "cancel"] as const) test(`queued cleanup rechecks ${reason} after mutation wait`, async () => {
  const {active, call, execute, tools, calls} = cleanupFixture();
  active.contextSessionId = "queued-fixture";
  let release!: () => void;
  tools.mutationTails.set(active.contextSessionId, new Promise<void>(resolve => {release = resolve;}));
  await call("summary", {type: "text", content: "Done", end_turn: true});
  const pending = execute();
  if (reason === "steer") active.pendingSteers.push({content: "stop"});
  else { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(); }
  release();
  await expect(pending).rejects.toThrow();
  expect(calls.map(c => c.name)).toEqual(["SendToUser"]);
  expect(active.toolActivityAfterLastSend).toBe(true);
});
