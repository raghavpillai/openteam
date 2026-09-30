import { expect, test } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";
import { routeEvent } from "../../src/runtime/events";

test("a rejected attachment after end_turn is not reported as successful delivery", async () => {
  const runtime = new ComputerRuntime() as any;
  const events: any[] = [];
  let prompts = 0;
  const active: any = {
    contextSessionId: "fixture", runId: "fixture", turnId: "fixture", botId: "fixture",
    runtimeProfile: "agent", requestSource: "turn", instructions: "fixture",
    modelRef: { providerId: "fixture", modelId: "fixture" },
    sentMessageCount: 0, toolActivityAfterLastSend: false, lastStopReason: "stop",
    attachmentTempDirectories: [], toolArgs: new Map(),
    queue: { push: (event: any) => events.push(event), end() {} },
  };
  active.session = {
    async prompt() {
      prompts++;
      // The summary was delivered with end_turn before its queued attachment.
      active.sentMessageCount = 1;
      active.endTurnRequested = true;
      routeEvent(undefined, active, { type: "tool_execution_start", toolCallId: "zip", toolName: "SendToUser", args: { type: "attachment", url: "file:///workspace/result.zip" } } as any);
      routeEvent(undefined, active, { type: "tool_execution_end", toolCallId: "zip", toolName: "SendToUser", isError: true, result: { content: [{ type: "text", text: "The turn has ended after delivery; wait for the next user message." }] } } as any);
    },
    getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [], messages: [],
  };
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  await runtime.execute(active, "fixture", []);
  expect(events.find(event => event.type === "turn.completed")).toMatchObject({ status: "failed" });
  expect(events.find(event => event.type === "turn.completed").error.message).toContain("A response was delivered");
  // Honor end_turn: surface the failure, without executing more work or retrying delivery.
  expect(prompts).toBe(1);
});

for (const scenario of ["pending", "pending-schema", "failed-schema", "other-work-schema", "completed", "failed-check", "other-work", "never-sent"] as const) {
  test(`background status polling preserves delivery obligation: ${scenario}`, async () => {
    const runtime = new ComputerRuntime() as any;
    const events: any[] = [];
    let calls = 0;
    const active: any = {
      contextSessionId: "fixture", runId: "fixture", turnId: "fixture", botId: "fixture",
      runtimeProfile: "agent", subagentType: null, requestSource: "turn",
      modelRef: {providerId: "fixture", modelId: "fixture"}, instructions: "fixture",
      sentMessageCount: scenario === "never-sent" ? 0 : 1,
      toolActivityAfterLastSend: scenario.startsWith("other-work"), lastStopReason: "stop",
      attachmentTempDirectories: [], toolArgs: new Map(),
      queue: {push: (e: any) => events.push(e), end() {}},
    };
    active.session = {
      async prompt() {
        calls++;
        if (scenario.includes("schema")) {
          routeEvent(undefined, active, {type: "tool_execution_start", toolCallId: "schema", toolName: "GetDynamicTools", args: {namespace: "cursor", toolName: "CheckSubagent"}} as any);
          routeEvent(undefined, active, {type: "tool_execution_end", toolCallId: "schema", toolName: "GetDynamicTools", isError: scenario === "failed-schema", result: {content: [], details: {namespaceCount: 1}}} as any);
        }
        routeEvent(undefined, active, {type: "tool_execution_start", toolCallId: "poll", toolName: "CallDynamicTool", args: {namespace: "cursor", toolName: "CheckSubagent", arguments: {subagent_id: "fixture"}}} as any);
        routeEvent(undefined, active, {type: "tool_execution_end", toolCallId: "poll", toolName: "CallDynamicTool", isError: scenario === "failed-check", result: {content: [], details: {tool: "CheckSubagent", pendingBackgroundWork: scenario !== "completed"}}} as any);
      },
      getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [], messages: [],
    };
    runtime.compaction = {beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {}};
    runtime.cleanup = async () => {};
    await runtime.execute(active, "fixture", []);
    expect(events.find(e => e.type === "turn.completed").status).toBe(["pending", "pending-schema"].includes(scenario) ? "completed" : "failed");
    expect(calls).toBe(["pending", "pending-schema"].includes(scenario) ? 1 : 2);
  });
}

for (const scenario of ["never-sent", "progress-only", "recovered", "delivered", "automation", "cancelled", "cancelled-between-steps", "cancelled-throws", "provider-throws"] as const) {
  test(`turn settlement after delivery ${scenario}`, async () => {
    const runtime = new ComputerRuntime() as any;
    const events: any[] = [];
    let calls=0;
    let settlements=0;
    const active:any={
      contextSessionId:"fixture",runId:"fixture",turnId:"fixture",botId:"fixture",
      runtimeProfile:"agent",subagentType:null,requestSource:scenario==="automation"?"automation":"turn",
      modelRef:{providerId:"fixture",modelId:"fixture"},instructions:"fixture",
      sentMessageCount:["progress-only","delivered"].includes(scenario)?1:0,
      toolActivityAfterLastSend:scenario==="progress-only",endTurnRequested:scenario==="delivered",
      lastStopReason:scenario==="cancelled"?"aborted":"stop",attachmentTempDirectories:[],
      pluginAbortController: new AbortController(),
      queue:{push:(e:any)=>events.push(e),end(){}},
    };
    active.session={
      async prompt(){calls++;if(scenario==="provider-throws") throw new Error("Provider unavailable");if(scenario.startsWith("cancelled-") ) { active.endTurnRequested=true; active.pluginAbortController.abort(); if(scenario==="cancelled-throws") throw new DOMException("Aborted", "AbortError"); }if(calls===2&&scenario==="recovered"){active.sentMessageCount=1;active.toolActivityAfterLastSend=false;active.endTurnRequested=true;}},
      getContextUsage:()=>undefined,getAllTools:()=>[],getActiveToolNames:()=>[],messages:[],
    };
    runtime.compaction={beginUserQuery:async()=>{},settleAtTurnEnd:async()=>{ settlements++; return null; },parkBackground(){}};
    let cleaned = false;
    runtime.cleanup=async()=>{ cleaned = true; };
    active.queue.push = (event: any) => {
      if (event.type === "turn.completed") expect(cleaned).toBe(true);
      events.push(event);
    };
    await runtime.execute(active,"fixture",[]);
    const completion=events.find(e=>e.type==="turn.completed");
    expect(completion.status).toBe(["never-sent","progress-only","provider-throws"].includes(scenario)?"failed":scenario.startsWith("cancelled")?"interrupted":"completed");
    if(completion.status==="failed") expect(completion.error.message).toContain(scenario==="provider-throws"?"Provider unavailable":scenario==="progress-only"?"A response was delivered":"without delivering");
    if(scenario==="provider-throws") expect(events.some(e=>e.type==="runtime.error")).toBe(true);
    expect(calls).toBe(["never-sent","progress-only","recovered"].includes(scenario)?2:1);
    if(scenario.startsWith("cancelled")) { expect(settlements).toBe(0); expect(events.some(e=>e.type==="runtime.error")).toBe(false); }
  });
}
