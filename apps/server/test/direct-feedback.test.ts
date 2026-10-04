import { afterEach, expect, test } from "bun:test";
import { FeedbackService } from "../src/services/feedback-service";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function fixture(status = 200) {
  const sent: unknown[] = [];
  const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    sent.push(await request.json());
    return new Response(null,{status});
  }});
  const keys = ["OPENTEAM_FEEDBACK_ALLOW_AGENT","OPENTEAM_FEEDBACK_URL","OPENTEAM_FEEDBACK_TOKEN","OPENTEAM_FEEDBACK_CONTACT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT="true";
  process.env.OPENTEAM_FEEDBACK_URL=server.url.href;
  delete process.env.OPENTEAM_FEEDBACK_TOKEN;
  delete process.env.OPENTEAM_FEEDBACK_CONTACT;
  cleanups.push(() => {server.stop(true);for(const key of keys) {
    if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  }});
  const records = new Map<string,any>();
  const tx = {
    $executeRaw: async () => {},
    idempotencyRecord: {
      findUnique: async ({where}:any) => records.get(where.scope_key.key) ?? null,
      findFirst: async () => [...records.values()][0] ?? null,
      create: async ({data}:any) => {const record={...data,status:"processing",response:null};records.set(data.key,record);return record;},
      update: async ({where,data}:any) => Object.assign(records.get(where.scope_key.key),data),
    },
  };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const db = {...tx,$transaction:(work:(tx:unknown)=>Promise<unknown>) => {
    const result=transactionTail.then(()=>work(tx));transactionTail=result.catch(()=>{});return result;
  }};
  const service = new FeedbackService(db as any);
  const context = {botId:"bot",callId:"feedback-call"} as any;
  const input = {message:"Synthetic fixture feedback",wantsResponse:false};
  return {service,context,input,sent};
}

test("requested feedback sends directly and simultaneous retries do not duplicate it", async () => {
  const {service,context,input,sent} = fixture();
  const results=await Promise.all([service.send(context,input),service.send(context,input)]);
  expect(results.some(result=>result.feedbackStatus==="sent")).toBe(true);
  expect(await service.send(context,input)).toMatchObject({feedbackStatus:"sent",wantsResponse:false});
  expect(sent).toEqual([{id:context.callId,product:"OpenTeam",...input}]);
  await expect(service.send(context,{...input,message:"Changed"})).rejects.toThrow("different content");
  expect(await service.send({...context,callId:"another"},input)).toMatchObject({feedbackStatus:"failed",outcome:expect.stringContaining("rate limited")});
  expect(sent).toHaveLength(1);
});

test("uncertain delivery is retained as a receipt rather than sent again", async () => {
  const {service,context,input,sent}=fixture(503);
  expect(await service.send(context,input)).toMatchObject({feedbackStatus:"unknown"});
  expect(await service.send(context,input)).toMatchObject({feedbackStatus:"unknown"});
  expect(sent).toHaveLength(1);
});

test("cancellation and missing reply preference prevent starting delivery", async () => {
  const {service,context,input,sent}=fixture();
  const controller=new AbortController();controller.abort();
  await expect(service.send(context,input,controller.signal)).rejects.toThrow();
  await expect(service.send(context,{message:input.message})).rejects.toThrow("wantsResponse");
  expect(sent).toHaveLength(0);
});
