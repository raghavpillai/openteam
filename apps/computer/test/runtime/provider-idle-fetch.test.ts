import { expect, test } from 'bun:test';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { providerIdleFetch } from '../../src/runtime/provider-idle-fetch';

const encoder=new TextEncoder();
const model:any={id:'fixture',name:'fixture',api:'openai-completions',provider:'fixture',baseUrl:'http://local.invalid/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:256};
const chunk=(delta:any,finish_reason:any=null)=>'data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
const fixture=(initial:string)=>{
 let cancelled=false,signal:AbortSignal|undefined;
 const request=(async (_input:any,init:any)=>{signal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(initial));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream','x-test':'preserved'}});}) as unknown as typeof fetch;
 return {request,get cancelled(){return cancelled},get signal(){return signal}};
};

test('stalled body becomes a provider error; complete and partial tool arguments never execute',async()=>{
 const {Agent}=await import(import.meta.resolve('@earendil-works/pi-agent-core',import.meta.resolve('@earendil-works/pi-coding-agent')));
 for(const argumentsText of ['{"value":','{"value":1}']) {
  const f=fixture(chunk({tool_calls:[{index:0,id:'call-fixture',type:'function',function:{name:'effect',arguments:argumentsText}}]}));
  let calls=0;
  const agent=new Agent({initialState:{model,systemPrompt:'fixture',tools:[{name:'effect',label:'effect',description:'fixture',parameters:{type:'object',properties:{value:{type:'number'}}},execute:async()=>{calls++;return {content:[{type:'text',text:'executed'}],details:{}};}}]},streamFn:(m:any,c:any,o:any)=>stream(m,c,{...o,apiKey:'local-test-not-a-key',maxRetries:0,fetch:providerIdleFetch(f.request,40)})});
  await agent.prompt('fixture');
  expect(calls).toBe(0);expect(agent.state.messages.at(-1).stopReason).toBe('error');
  expect(agent.state.messages.at(-1).errorMessage).toContain('idle timeout');
  expect(isRetryableAssistantError(agent.state.messages.at(-1))).toBe(true);
  expect(f.cancelled).toBe(true);expect(f.signal?.aborted).toBe(true);
 }
});

test('continuous response can exceed idle budget; headers and content are preserved',async()=>{
 let interval:ReturnType<typeof setInterval>;
 const request=(async()=>new Response(new ReadableStream({start(c){let n=0;interval=setInterval(()=>{c.enqueue(encoder.encode(String(n++)));if(n===7){clearInterval(interval);c.close();}},15);},cancel(){clearInterval(interval);}}),{headers:{'x-test':'preserved'}})) as unknown as typeof fetch;
 const started=performance.now();const response=await providerIdleFetch(request,60)('http://fixture');
 expect(await response.text()).toBe('0123456');expect(performance.now()-started).toBeGreaterThan(60);expect(response.headers.get('x-test')).toBe('preserved');
});

test('caller cancellation and consumer cancellation reach the original request',async()=>{
 const f=fixture('first');const controller=new AbortController();
 const response=await providerIdleFetch(f.request,1000)('http://fixture',{signal:controller.signal});
 const read=response.text();controller.abort(new Error('caller stop'));
 await expect(read).rejects.toThrow('caller stop');expect(f.cancelled).toBe(true);
 const second=fixture('first');const r=await providerIdleFetch(second.request,1000)('http://fixture');await r.body!.cancel();expect(second.cancelled).toBe(true);expect(second.signal?.aborted).toBe(true);
});

test('finish reason without EOF still times out; disabling idle guard preserves the fetch implementation',async()=>{
 const f=fixture(chunk({content:'done'},'stop'));
 const s=stream(model,{messages:[{role:'user',content:'fixture',timestamp:Date.now()}]},{apiKey:'local-test-not-a-key',maxRetries:0,fetch:providerIdleFetch(f.request,40)});
 const result=await s.result();expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('idle timeout');expect(providerIdleFetch(f.request,0)).toBe(f.request);
});
