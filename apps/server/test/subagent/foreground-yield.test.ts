import {expect,test} from 'bun:test';
import {SubagentService} from '../../src/services/subagent/service';
import {hashRequest} from '../../src/services/service-utils';
for (const terminal of [false,true]) test(`foreground yield persists wake ownership or returns raced completion: ${terminal}`,async()=>{
 const input={prompt:'do test',description:'test',subagent_type:'computerUse',run_in_background:false};
 let update:any;
 const attempt={id:'attempt',subagentId:'child',status:'running',runInBackground:false};
 const db:any={subagent:{findUnique:async()=>null},idempotencyRecord:{findUnique:async()=>({requestHash:hashRequest(input),response:{subagentId:'child'}})},
 subagentAttempt:{updateMany:async(q:any)=>{update=q;return {count:terminal?0:1}},findUniqueOrThrow:async()=>({...attempt,status:'completed',result:'BETA926'})}};
 const service=new SubagentService(db,null as any,null as any,'/workspace',null as any,null as any) as any;
 service.attemptForCall=async()=>attempt;service.owned=async()=>({id:'child'});
 const result=await service.task({botId:'parent',callId:'same-call'},input,undefined,true);
 expect(update.data.runInBackground).toBe(true);
 expect(update.where.id).toBe('attempt');
 if(terminal)expect(result).toContain('BETA926');else expect(result.foregroundYielded).toBe(true);
});
