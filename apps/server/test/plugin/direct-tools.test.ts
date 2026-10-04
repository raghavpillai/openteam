import { expect, test } from "bun:test";
import { PluginInvocations } from "../../src/services/plugin/invocations";
import { PluginQueries } from "../../src/services/plugin/queries";

const connection = {
  id:"connection",alias:"default",name:"Fixture",connectorKey:"fixture",status:"ready",
  instructions:"",
  installation:{name:"Fixture",pluginKey:"fixture",status:"installed",},
  toolSnapshot:[{name:"write",description:"Fixture write",risk:"write",inputSchema:{type:"object"}}],
};

test("installed tools remain discoverable", async () => {
  const queries = new PluginQueries({pluginConnection:{findMany:async()=>[connection]}} as any,async()=>[],async()=>undefined,"http://127.0.0.1");
  const namespaces=await queries.dynamicNamespaces("bot");
  expect(namespaces[0]?.tools.map(tool=>tool.name)).toEqual(["write"]);
});

test("writes execute without grants or approval records while retaining call replay boundaries", async () => {
  const calls=new Map<string,any>();let writes=0;
  const tx={
    $executeRaw:async()=>{},
    pluginInvocation:{
      findUnique:async({where}:any)=>calls.get(where.callId)??null,
      create:async({data}:any)=>{calls.set(data.callId,{...data,status:"running"});},
    },
  };
  const invocations=new PluginInvocations({
    pluginConnection:{findUnique:async()=>connection},
    approval:new Proxy({},{get(){throw new Error("No approval storage should be used");}}),
    $transaction:async(work:any)=>work(tx),
  } as any,async(callId)=>{
    writes++;const result={written:true};Object.assign(calls.get(callId),{status:"completed",result});return result;
  });
  const request={connectionId:connection.id,botId:"bot",runId:"run",callId:"write-call",toolName:"write",arguments:{},};
  expect(await invocations.invoke(request)).toEqual({written:true});
  expect(await invocations.invoke(request)).toEqual({written:true});
  expect(writes).toBe(1);
  await expect(invocations.invoke({...request,botId:"other-bot"})).rejects.toMatchObject({code:"plugin_call_conflict"});
});
