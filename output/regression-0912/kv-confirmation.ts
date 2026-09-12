import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const [auditRoot, output, first="baseline"] = process.argv.slice(2);
const root=await mkdtemp(join(tmpdir(),"openteam-kv-confirm-"));
const stores:any={}; const results=[];
const id="11111111-1111-4111-8111-111111111111";
try {
  for(const arm of first==="baseline"?["baseline","candidate"]:["candidate","baseline"]){
    const {BotAgentStore}=await import(join(auditRoot!,arm,"apps/computer/src/bot-agent-store.ts"));
    stores[arm]=new BotAgentStore(join(root,arm));await stores[arm].openForWake(id);
  }
  for(const operation of ["write","read","roundtrip"]){
    const samples:any={baseline:[],candidate:[]};
    for(let sample=-60;sample<100;sample++)for(const arm of sample%2?["baseline","candidate"]:["candidate","baseline"]){
      const store=stores[arm], start=performance.now();let result;
      for(let i=0;i<500;i++){
        if(operation!=="read")await store.writeKv(id,"qa-key",`${sample}-${i}`);
        if(operation!=="write")result=await store.readKv(id,"qa-key");
      }
      if(sample>=0)samples[arm].push((performance.now()-start)*1000/500);
      if(operation==="roundtrip")assert.equal(result,`${sample}-499`);
    }
    results.push({operation,unit:"microseconds/operation",samples});
    console.log(JSON.stringify({operation,medianUs:Object.fromEntries(Object.entries(samples).map(([arm,v]:any)=>[arm,[...v].sort((a,b)=>a-b)[50]]))}));
  }
  await Bun.write(output!,JSON.stringify({first,warmupBatches:60,sampleBatches:100,batchSize:500,results}));
} finally {for(const store of Object.values(stores) as any[])await store.closeAll();await rm(root,{recursive:true,force:true});}
