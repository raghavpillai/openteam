import {expect,test} from 'bun:test';
import {WakeWorker} from '../src/worker';
for (const method of ['completeSubagent','failSubagent']) test(`${method} sees a yield committed after its initial read`, async()=>{
 const worker=Object.create(WakeWorker.prototype) as any;
 let notified=0;
 worker.notifySubagentParent=async()=>{notified++};
 const tx:any={
  subagent:{findFirst:async()=>({id:'child',status:'running'}),update:async()=>({})},
  subagentAttempt:{findUnique:async()=>({id:'attempt',status:'running',runInBackground:false}),update:async()=>({runInBackground:true})},
  message:{findFirst:async()=>({content:'BETA926'})},runItem:{findMany:async()=>[]},event:{create:async()=>({})},
 };
 await worker[method](tx,{botId:'bot',runId:'run'},{message:'test failure'});
 expect(notified).toBe(1);
});
