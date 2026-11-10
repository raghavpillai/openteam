import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import { routeEvent } from "../../src/runtime/events";

const attachment = {type: "attachment", url: "https://example.invalid/report.zip"};
function fixture() {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {runId: "fixture", botId: "fixture", screenBotId: "fixture", sentMessageCount: 0, queue: {push() {}}};
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

for (const scenario of ["cancelled", "interrupted", "failed", "next-response"] as const) {
  test(`delivery grace respects ${scenario}`, async () => {
    const {active, calls, call, tools, batch} = fixture();
    if (scenario === "next-response") batch([]);
    await call("summary", {type: "text", content: "Done", end_turn: true});
    const controller = new AbortController();
    if (scenario === "cancelled") controller.abort(new Error("stopped"));
    if (scenario === "interrupted") { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(new Error("interrupted by user")); }
    if (scenario === "failed") tools.callControlPlaneTool = async () => {throw new Error("delivery failed");};
    await expect(call("zip", attachment, "SendToUser", controller.signal)).rejects.toThrow();
    if (scenario === "failed") await expect(call("zip", attachment)).rejects.toThrow("turn has ended");
    expect(calls).toHaveLength(1);
  });
}

const stop = {namespace: "cursor", toolName: "StopSubagent", arguments: {subagent_id: "worker"}};
function cleanupFixture() {
  const f = fixture();
  Object.assign(f.active, {toolArgs: new Map(), pluginNamespaces: []});
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
  await execute();
  expect(active.failedResponseCalls).toEqual([]);
  expect(calls.map(c => c.name)).toEqual(["SendToUser", "StopSubagent"]);
  await expect(execute()).rejects.toThrow("turn has ended");
});

for (const scenario of ["changed", "new", "failed", "cancelled", "interrupted", "later", "read-only"] as const) {
  test(`worker cleanup grace respects ${scenario}`, async () => {
    const {active, call, execute, tools, batch} = cleanupFixture();
    await call("summary", {type: "text", content: "Done", end_turn: true});
    if (scenario === "interrupted") { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(new Error("interrupted by user")); }
    if (scenario === "failed") tools.callControlPlaneTool = async () => {throw new Error("stop failed");};
    if (scenario === "cancelled") { active.pluginAbortController = new AbortController(); active.pluginAbortController.abort(); }
    if (scenario === "read-only") active.readOnly = true;
    if (scenario === "later") batch([{type: "toolCall", name: "CallDynamicTool", id: "later", arguments: stop}]);
    await expect(execute(scenario === "changed" ? {...stop, arguments: {subagent_id: "other"}} : stop,
      ["new", "later"].includes(scenario) ? scenario : "stop")).rejects.toThrow();
  });
}

test("queued cleanup rechecks cancel after mutation wait", async () => {
  const {active, call, execute, tools, calls} = cleanupFixture();
  active.contextSessionId = "queued-fixture";
  let release!: () => void;
  tools.mutationTails.set(active.contextSessionId, new Promise<void>(resolve => {release = resolve;}));
  await call("summary", {type: "text", content: "Done", end_turn: true});
  const pending = execute();
  active.pluginAbortController = new AbortController(); active.pluginAbortController.abort();
  release();
  await expect(pending).rejects.toThrow();
  expect(calls.map(c => c.name)).toEqual(["SendToUser"]);
});

const routine = {action: "create", name: "Check back", prompt: "Check the support case and tell the user in this chat.", schedule: "10 13 18 10 *"};
function siblingFixture(failing?: string) {
  const f = fixture();
  Object.assign(f.active, {toolArgs: new Map()});
  if (failing) {
    const deliver = f.tools.callControlPlaneTool;
    f.tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
      if (name === failing) throw new Error(`${name} rejected`);
      return deliver(turn, id, name, args);
    };
  }
  // Pi announces the raw arguments, then executes with its validated copy.
  const run = async (id: string, raw: any, name: string, validated = raw) => {
    routeEvent(undefined, f.active, {type: "tool_execution_start", toolName: name, toolCallId: id, args: raw} as any);
    let result: any, isError = false;
    try { return result = await f.call(id, validated, name); }
    catch (error) { isError = true; result = {isError: true}; throw error; }
    finally { routeEvent(undefined, f.active, {type: "tool_execution_end", toolName: name, toolCallId: id, result, isError} as any); }
  };
  const reply = {type: "text", content: "I'll check back at 1:10 PM.", end_turn: true};
  const raw = {...routine, trigger: null};
  f.batch([
    {type: "toolCall", name: "SendToUser", id: "reply", arguments: reply},
    {type: "toolCall", name: "UpdateRoutine", id: "routine", arguments: raw},
  ]);
  return {...f, run, reply, raw};
}

test("a call emitted with the closing reply still runs, once, without a new delivery obligation", async () => {
  const {active, calls, run, reply, raw, batch} = siblingFixture();
  await run("reply", reply, "SendToUser");
  expect(active.endTurnRequested).toBe(true);
  await run("routine", raw, "UpdateRoutine", routine);
  expect(calls.map(c => [c.id, c.name])).toEqual([["reply", "SendToUser"], ["routine", "UpdateRoutine"]]);
  expect(active.failedResponseCalls).toEqual([]);
  await expect(run("routine", raw, "UpdateRoutine", routine)).rejects.toThrow("turn has ended");
  // A later response gets no grant, even for a call the closing response made.
  batch([{type: "toolCall", name: "UpdateRoutine", id: "later", arguments: routine}]);
  await expect(run("later", routine, "UpdateRoutine")).rejects.toThrow("turn has ended");
  expect(calls).toHaveLength(2);
});

test("a call alongside the closing reply that fails is recorded for the model to see", async () => {
  const {active, calls, run, reply, raw} = siblingFixture("UpdateRoutine");
  await run("reply", reply, "SendToUser");
  await expect(run("routine", raw, "UpdateRoutine", routine)).rejects.toThrow("UpdateRoutine rejected");
  expect(calls.map(c => c.name)).toEqual(["SendToUser"]);
  expect(active.failedResponseCalls).toEqual(["routine"]);
});

test("a failure before the closing reply in the same response is recorded too", async () => {
  const f = siblingFixture("UpdateRoutine");
  f.batch([
    {type: "toolCall", name: "UpdateRoutine", id: "routine", arguments: f.raw},
    {type: "toolCall", name: "SendToUser", id: "reply", arguments: f.reply},
  ]);
  await expect(f.run("routine", f.raw, "UpdateRoutine", routine)).rejects.toThrow("UpdateRoutine rejected");
  await f.run("reply", f.reply, "SendToUser");
  expect(f.active.endTurnRequested).toBe(true);
  expect(f.active.failedResponseCalls).toEqual(["routine"]);
});

const question = {type: "widget", widget: {prompt: "Check back at 1:10 PM?", options: [{label: "Yes", value: "yes", style: "primary"}]}};
const reply = {type: "text", content: "I'll check back at 1:10 PM.", end_turn: true};
function responseFixture(parts: [string, string, any][], failing?: (name: string, args: any) => boolean) {
  const f = fixture();
  if (failing) {
    const deliver = f.tools.callControlPlaneTool;
    f.tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
      if (failing(name, args)) throw new Error(`${id} rejected`);
      return deliver(turn, id, name, args);
    };
  }
  f.batch(parts.map(([id, name, args]) => ({type: "toolCall", name, id, arguments: args})));
  return f;
}

test("a question card still runs the rest of its response, once, and waits on the user", async () => {
  const {active, calls, call, batch} = responseFixture([["ask", "SendToUser", question], ["note", "SendToUser", {type: "text", content: "I saved the case notes."}], ["zip", "SendToUser", attachment]]);
  await call("ask", question);
  expect(active.endTurnRequested).toBe(true);
  expect(active.awaitingUser).toBe(true);
  await call("note", {type: "text", content: "I saved the case notes."});
  await call("zip", attachment);
  await expect(call("new", attachment)).rejects.toThrow("turn has ended");
  batch([{type: "toolCall", name: "SendToUser", id: "later", arguments: attachment}]);
  await expect(call("later", attachment)).rejects.toThrow("turn has ended");
  expect(calls.map(x => x.id)).toEqual(["ask", "note", "zip"]);
});

test("a question after a failed send in the same response is held and the turn stays open", async () => {
  const {active, calls, call} = responseFixture([["zip", "SendToUser", attachment], ["ask", "SendToUser", question]], (_name, args) => args.type === "attachment");
  await expect(call("zip", attachment)).rejects.toThrow("zip rejected");
  await expect(call("ask", question)).rejects.toThrow("An earlier message in this response was not delivered (its own result says why), so this question was not shown either and the turn is still yours.");
  expect(calls).toEqual([]);
  expect(active.endTurnRequested).toBeFalsy();
  expect(active.awaitingUser).toBeFalsy();
});

test("end_turn after a failed send in the same response delivers without ending the turn", async () => {
  const {active, calls, call, batch} = responseFixture([["zip", "SendToUser", attachment], ["reply", "SendToUser", reply]], (_name, args) => args.type === "attachment");
  await expect(call("zip", attachment)).rejects.toThrow("zip rejected");
  await call("reply", reply);
  expect(calls.map(x => x.id)).toEqual(["reply"]);
  expect(active.endTurnRequested).toBeFalsy();
  expect(active.finishResponseCalls).toBeFalsy();
  // A failure in another tool does not change this; only a failed send does.
  batch([{type: "toolCall", name: "SendToUser", id: "again", arguments: reply}]);
  await call("again", reply);
  expect(active.endTurnRequested).toBe(true);
});

for (const closing of ["attachment", "reaction"] as const)
  test(`a closing ${closing} still runs the rest of its response`, async () => {
    const close = closing === "attachment" ? ["done", "SendToUser", {...attachment, end_turn: true}] as [string, string, any] : ["done", "ReactToMessage", {message_address: "t1u", emoji: "\u{1F44D}", end_turn: true}] as [string, string, any];
    const {active, calls, call, tools} = responseFixture([close, ["zip", "SendToUser", attachment]]);
    if (closing === "reaction") {
      const deliver = tools.callControlPlaneTool;
      tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
        if (name !== "ReactToMessage") return deliver(turn, id, name, args);
        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async () => { calls.push({id, name, args}); return Response.json({reacted: true}); }) as any;
          return await tools.callControlPlaneToolRequest(turn, id, name, args);
        } finally { globalThis.fetch = originalFetch; }
      };
    }
    await call(close[0], close[2], close[1]);
    expect(active.endTurnRequested).toBe(true);
    expect(active.finishResponseCalls).toBe(true);
    await call("zip", attachment);
    expect(calls.map(x => x.id)).toEqual(["done", "zip"]);
  });

test("every main-agent tool runs in parallel; only graphical controls stay sequential", () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const base = {requestSource: "turn", subagentType: null, readOnly: false, pluginRuntimePackages: [], pluginNamespaces: []};
  const main = tools.customTools(base);
  expect(main.map((tool: any) => tool.name)).toContain("SendToUser");
  expect(main.filter((tool: any) => tool.executionMode !== "parallel")).toEqual([]);
  const graphical = tools.customTools({...base, subagentType: "computerUse"});
  expect(graphical.filter((tool: any) => tool.executionMode === "sequential").map((tool: any) => tool.name)).toContain("Computer");
  expect(graphical.find((tool: any) => tool.name === "Shell").executionMode).toBe("parallel");
});

test("an ack goes out at once beside other calls, and sends of one response keep call order", async () => {
  const {active, tools} = fixture();
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  tools.callControlPlaneTool = async (_turn: any, id: string) => {
    order.push(`start:${id}`);
    await new Promise<void>((resolve) => releases.set(id, resolve));
    order.push(`end:${id}`);
    return {content: [{type: "text", text: "ok"}], details: {}};
  };
  const ack = tools.executeOpenTeamTool(active, "ack", "SendToUser", {type: "text", content: "On it"});
  const second = tools.executeOpenTeamTool(active, "second", "SendToUser", {type: "text", content: "Found it"});
  const work = tools.executeOpenTeamTool(active, "work", "RecallMemory", {query: "tea"});
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
