import {expect,test} from 'bun:test';
import {Effect} from 'effect';
import {SubagentService} from '../../src/services/subagent/service';
function fixture(cancel:()=>Promise<void>, runStatus='running') {
 const child:any={id:'child',parentBotId:'parent',currentRunId:'run',status:'running'};
 const events:any[]=[];
 const db:any={
  subagent:{findFirst:async()=>({...child}),findUnique:async()=>({...child}),update:async({data}:any)=>Object.assign(child,data),updateMany:async({where,data}:any)=>{
   if(where.currentRunId!==child.currentRunId||!where.status.in.includes(child.status))return {count:0};Object.assign(child,data);return {count:1};}},
  subagentAttempt:{updateMany:async()=>({count:1})},
  run:{findUnique:async()=>({status:runStatus})},
  event:{create:async({data}:any)=>events.push(data)}
 };
 db.$transaction=async(fn:any)=>fn(db);
 const service=new SubagentService(db,{} as never,{cancel:()=>Effect.tryPromise(cancel)} as never,'/workspace',{} as never,{} as never);
 return {service,child,events};
}
test('failed cancellation leaves worker active and retryable, never reports stopped',async()=>{
 const f=fixture(async()=>{throw new Error('computer connection timeout')});
 await expect(f.service.stop('parent','call',{subagent_id:'child'})).rejects.toThrow();
 expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
});
test('stop does not announce completion while cancellation is pending',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);const f=fixture(()=>pending);
 const result=f.service.stop('parent','call',{subagent_id:'child'});
 await new Promise(r=>setTimeout(r,10));expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
 release();expect(await result).toMatchObject({stopped:true,status:'stopped'});expect(f.child.status).toBe('stopped');
});
test('terminal run racing with failed cancellation can settle stopped',async()=>{
 const f=fixture(async()=>{throw new Error('already finished')},'completed');
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toMatchObject({stopped:true});
});
test('completion race is not overwritten as stopped',async()=>{
 const f=fixture(async()=>{f.child.status='completed'});
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toMatchObject({stopped:false,status:'completed'});
 expect(f.child.status).toBe('completed');expect(f.events).toHaveLength(0);
});
test('new attempt is not stopped by acknowledgement for an older attempt',async()=>{
 const f=fixture(async()=>{f.child.currentRunId='new-run'});
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toMatchObject({stopped:false,status:'running'});
 expect(f.child.currentRunId).toBe('new-run');expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
});
