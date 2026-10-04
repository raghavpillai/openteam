import { describe, expect, test } from "bun:test";
import { PluginService } from "../../src/services/plugin-service";

function fixture() {
  const records = new Map<string, any>();
  let executions = 0;
  const db = {
    approval: new Proxy({}, {get(){throw new Error("Approval storage must not be used");}}),
    idempotencyRecord: {
      findUnique: async ({where}:any) => records.get(where.scope_key.key) ?? null,
      create: async ({data}:any) => {
        if(records.has(data.key)) throw new Error("Duplicate claim");
        const record = {...data,status:"processing",response:null}; records.set(data.key,record);return record;
      },
      update: async ({where,data}:any) => {Object.assign(records.get(where.scope_key.key),data);},
    },
  };
  const service = new PluginService(db as any);
  Object.assign(service, {
    connectionStatuses: async () => ({}),
    catalogDetail: async () => ({installed:true}),
    resolveToolArguments: async (_:string,args:unknown) => args,
    executeAction: async () => {executions++;await Promise.resolve();return {installed:true};},
  });
  const request = {runId:"run",botId:"bot",callId:"call",action:"InstallPlugin",arguments:{pluginKey:"fixture"}};
  return {service,request,records,executions:()=>executions};
}

describe("plugin management without review", () => {
  test("executes immediately and replays the stored receipt without another install", async () => {
    const {service,request,executions} = fixture();
    expect(await service.requestAction(request)).toMatchObject({status:"completed",completed:true,actionResult:{installed:true},detail:{installed:true}});
    expect(await service.requestAction(request)).toMatchObject({completed:true});
    expect(executions()).toBe(1);
    await expect(service.requestAction({...request,arguments:{pluginKey:"different"}})).rejects.toThrow("another action");
  });

  test("concurrent callers execute an action once", async () => {
    const {service,request,executions} = fixture();
    const results = await Promise.allSettled([service.requestAction(request),service.requestAction(request)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(executions()).toBe(1);
  });

  test("cancellation prevents starting work and uncertain writes are not repeated", async () => {
    const {service,request,executions} = fixture();
    const controller = new AbortController();controller.abort();
    await expect(service.requestAction(request,controller.signal)).rejects.toThrow();
    expect(executions()).toBe(0);
    Object.assign(service,{executeAction:async()=>{throw new Error("Connection lost after starting");}});
    await expect(service.requestAction(request)).rejects.toThrow("Connection lost");
    await expect(service.requestAction(request)).rejects.toThrow("already started");
  });
});
