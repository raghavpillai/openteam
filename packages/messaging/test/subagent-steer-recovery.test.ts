import { expect, test } from "bun:test";
import { AgentMessaging } from "../src/index";

for (const type of ["subagent.steer", "message.created"]) {
  test(`orphan steering recovery respects task scope: ${type}`, async () => {
    const updates: any[] = [];
    const runs: any[] = [];
    const wakes: any[] = [];
    const inbox = {id:"inbox", botId:"child", conversationId:"conversation", runId:"old-run", type,
      deliveryMode:"steer",status:"processing",run:{id:"old-run",status:"interrupted"},
      payload:{messageId:"message",content:"continue",clientId:"client",channelId:"channel"}};
    const tx: any = {
      $executeRaw: async () => 1,
      inboxEvent:{findUnique:async()=>inbox,update:async(x:any)=>{updates.push(x);return x;}},
      run:{create:async(x:any)=>{runs.push(x);return {id:"new-run"};}},
      message:{update:async()=>({})},event:{create:async()=>({})},
    };
    const messaging: any = Object.create(AgentMessaging.prototype);
    messaging.boss={send:async(...args:any[])=>wakes.push(args)};
    const result=await messaging.promoteSteerToWake(tx,"inbox","run_settled");
    if(type==="subagent.steer") {
      expect(result.promoted).toBe(false);
      expect(runs).toHaveLength(0);
      expect(wakes).toHaveLength(0);
      expect(updates[0].data.status).toBe("failed");
      expect(updates[0].data.error.code).toBe("subagent_steer_target_ended");
    } else {
      expect(result.promoted).toBe(true);
      expect(runs).toHaveLength(1);
      expect(wakes).toHaveLength(1);
      expect(updates[0].data.deliveryMode).toBe("turn");
    }
  });
}
