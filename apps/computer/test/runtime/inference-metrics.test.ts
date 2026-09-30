import { expect, spyOn, test } from "bun:test";
import { inferenceMetricsExtension } from "../../src/runtime/inference-metrics";

test("in-flight inference timestamps expose no request or response content", async () => {
  const handlers = new Map<string, Function>();
  const logs: string[] = [];
  const spy = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
  try {
    await inferenceMetricsExtension("fixture-run").factory({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    const start = () => handlers.get("before_provider_request")!({ payload: {
      model: "fixture-model", reasoning: { effort: "low" },
      input: [{ content: "PRIVATE_PROMPT" }], tools: [{ description: "PRIVATE_SCHEMA" }],
    } }, { sessionManager: { getSessionId: () => "fixture-session" } });
    start();
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: "inference.started", ordinal: 1, runId: "fixture-run" });
    handlers.get("message_update")!({ assistantMessageEvent: {type: "text_delta", delta: "PRIVATE_OUTPUT"} });
    handlers.get("message_update")!({ assistantMessageEvent: {type: "text_delta", delta: "PRIVATE_OUTPUT"} });
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1]!)).toMatchObject({ event: "inference.first_delta", ordinal: 1 });
    expect(JSON.parse(logs[1]!).firstDeltaMs).toBeGreaterThanOrEqual(0);
    start();
    handlers.get("message_update")!({ assistantMessageEvent: {type: "text_delta", delta: "PRIVATE_OUTPUT"} });
    expect(JSON.parse(logs[3]!)).toMatchObject({ event: "inference.first_delta", ordinal: 2 });
    expect(logs.join("\n")).not.toContain("PRIVATE_");
  } finally { handlers.get("session_shutdown")?.(); spy.mockRestore(); }
});

test("periodic stream diagnostics count progress without retaining content and stop on lifecycle boundaries", async () => {
  const handlers = new Map<string, Function>(), callbacks: Function[] = [], logs: string[] = [];
  const info = spyOn(console, 'info').mockImplementation(value => { logs.push(String(value)); });
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((fn: Function) => { callbacks.push(fn); return {unref() {}}; }) as any);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  try {
    await inferenceMetricsExtension('stream-fixture').factory({on:(name:string,fn:Function)=>handlers.set(name,fn)} as any);
    const start=()=>handlers.get('before_provider_request')!({payload:{model:'fixture-model',input:[{secret:'PRIVATE_PROMPT'}]}},{sessionManager:{getSessionId:()=> 'stream-fixture-session'}});
    start();
    for(const type of ['text_delta','thinking_delta','toolcall_delta'])
      handlers.get('message_update')!({assistantMessageEvent:{type,delta:'PRIVATE_CONTENT'},message:{secret:'PRIVATE_MESSAGE'}});
    callbacks.at(-1)!();
    const p=JSON.parse(logs.at(-1)!);
    expect(p).toMatchObject({event:'inference.progress',ordinal:1,updates:3,textCharacters:15,thinkingCharacters:15,toolArgumentCharacters:15});
    expect(p.lastUpdateMs).toBeGreaterThanOrEqual(0);expect(p.idleMs).toBeGreaterThanOrEqual(0);
    handlers.get('message_end')!({message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'PRIVATE_FINAL'}],usage:{input:1,output:2,cacheRead:0,reasoning:1}}});
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({event:'inference.metrics',updates:3,toolArgumentCharacters:15});
    const completed=logs.length;callbacks.at(-1)!();expect(logs.length).toBe(completed);
    start();callbacks.at(-1)!();expect(JSON.parse(logs.at(-1)!)).toMatchObject({ordinal:2,updates:0,lastUpdateMs:null});
    handlers.get('agent_end')!();const stopped=logs.length;callbacks.at(-1)!();expect(logs.length).toBe(stopped);
    start();handlers.get('session_shutdown')!();const shut=logs.length;callbacks.at(-1)!();expect(logs.length).toBe(shut);
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(logs.join('\n')).not.toContain('PRIVATE_');
  } finally {handlers.get('session_shutdown')?.();info.mockRestore();timer.mockRestore();clear.mockRestore();}
});


test("metadata-only stream updates do not establish first output, and chat requests remain correlatable", async () => {
  const handlers = new Map<string, Function>(), logs: string[] = [];
  const info = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
  try {
    await inferenceMetricsExtension("chat-fixture").factory({on:(name:string,fn:Function)=>handlers.set(name,fn)} as any);
    handlers.get("before_provider_request")!({payload:{model:"fixture",messages:[{content:"PRIVATE_INPUT"}]}},{sessionManager:{getSessionId:()=>"fixture-session"}});
    for (const delta of [{type:"start"},{type:"thinking_start"},{type:"toolcall_start"},{type:"text_delta",delta:""}])
      handlers.get("message_update")!({assistantMessageEvent:delta});
    expect(logs.map(line=>JSON.parse(line).event)).toEqual(["inference.started"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({inputItems:1});
    handlers.get("message_update")!({assistantMessageEvent:{type:"thinking_delta",delta:"PRIVATE_REASONING"}});
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({event:"inference.first_delta"});
    handlers.get("message_end")!({message:{role:"assistant",responseId:"fixture-generation",stopReason:"stop",content:[],usage:{input:1,output:1}}});
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({responseId:"fixture-generation"});
    expect(logs.join("\n")).not.toContain("PRIVATE_");
  } finally {handlers.get("session_shutdown")?.();info.mockRestore();}
});
