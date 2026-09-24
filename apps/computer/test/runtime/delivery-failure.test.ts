import { expect, test } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";

for (const scenario of ["never-sent", "progress-only", "recovered", "delivered", "automation", "cancelled"] as const) {
  test(`turn settlement after delivery ${scenario}`, async () => {
    const runtime = new ComputerRuntime() as any;
    const events: any[] = [];
    let calls=0;
    const active:any={
      contextSessionId:"fixture",runId:"fixture",turnId:"fixture",botId:"fixture",
      runtimeProfile:"agent",subagentType:null,requestSource:scenario==="automation"?"automation":"turn",
      modelRef:{providerId:"fixture",modelId:"fixture"},instructions:"fixture",
      sentMessageCount:["progress-only","delivered"].includes(scenario)?1:0,
      toolActivityAfterLastSend:scenario==="progress-only",endTurnRequested:scenario==="delivered",
      lastStopReason:scenario==="cancelled"?"aborted":"stop",attachmentTempDirectories:[],
      queue:{push:(e:any)=>events.push(e),end(){}},
    };
    active.session={
      async prompt(){calls++;if(calls===2&&scenario==="recovered"){active.sentMessageCount=1;active.toolActivityAfterLastSend=false;active.endTurnRequested=true;}},
      getContextUsage:()=>undefined,getAllTools:()=>[],getActiveToolNames:()=>[],messages:[],
    };
    runtime.compaction={beginUserQuery:async()=>{},settleAtTurnEnd:async()=>null,parkBackground(){}};
    runtime.cleanup=async()=>{};
    await runtime.execute(active,"fixture",[]);
    const completion=events.find(e=>e.type==="turn.completed");
    expect(completion.status).toBe(["never-sent","progress-only"].includes(scenario)?"failed":scenario==="cancelled"?"interrupted":"completed");
    if(completion.status==="failed") expect(completion.error.message).toContain("without delivering");
    expect(calls).toBe(["never-sent","progress-only","recovered","cancelled"].includes(scenario)?2:1);
  });
}
