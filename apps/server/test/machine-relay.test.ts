import { test, expect } from "bun:test";
import { MachineRelay } from "../src/machine-relay";

test("an upload started on an old connection is cancelled instead of delivered after reconnect", async () => {
  const relay = new MachineRelay(1, 1000);
  try {
    relay.connect("one");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      cancel() { cancelled = true; },
    });
    const result = relay.forward("one", "/v1/file-transfer/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", new Request("http://fixture/upload", {
      method: "PUT", body, duplex: "half",
    } as RequestInit)).catch(error => error as Error);
    const next = relay.connect("one");
    expect((await result as Error).message).toContain("disconnected");
    expect(cancelled).toBe(true);
    expect((await relay.poll("one", next.connectionId, [], new AbortController().signal)).requests).toEqual([]);
  } finally { relay.close(); }
});

test("relay leases isolate machines and never dispatch or consume a request twice", async () => {
  const relay=new MachineRelay(1,1000);
  try {
    const first=relay.connect("one"),second=relay.connect("two");
    const result=relay.forward("one","/v1/shell",new Request("http://fixture/v1/shell",{method:"POST",body:"payload"}));
    const batch=await relay.poll("one",first.connectionId,[],new AbortController().signal);
    const id=batch.requests[0]!.id;
    expect((await relay.poll("one",first.connectionId,[],new AbortController().signal)).requests).toEqual([]);
    expect(()=>relay.body("two",second.connectionId,id)).toThrow("no longer active");
    expect(()=>relay.body("one","old-connection",id)).toThrow("disconnected");
    expect(await relay.body("one",first.connectionId,id).text()).toBe("payload");
    expect(()=>relay.body("one",first.connectionId,id)).toThrow("already delivered");
    const receipt=relay.respond("one",first.connectionId,id,new Request("http://fixture/response",{method:"POST",headers:{"x-openteam-status":"200"},body:"result"}));
    expect(await (await result).text()).toBe("result");expect((await receipt).status).toBe(204);
    const inflight=relay.forward("one","/v1/read",new Request("http://fixture/read",{method:"POST",body:"{}"})).catch(error=>error as Error);
    const old=await relay.poll("one",first.connectionId,[],new AbortController().signal);
    const fresh=relay.connect("one");expect((await inflight as Error).message).toContain("may have run");
    expect((await relay.poll("one",fresh.connectionId,[],new AbortController().signal)).requests).toEqual([]);
    expect(()=>relay.fail("one",first.connectionId,old.requests[0]!.id)).toThrow("disconnected");
    expect(()=>relay.forward("one","/arbitrary-local-endpoint",new Request("http://fixture"))).toThrow("Unsupported");
  }finally{relay.close();}
});

test("disconnect cancels streaming responses and explicit failure promptly releases the caller",async()=>{
  const relay=new MachineRelay(1,1000);
  try{
    const connection=relay.connect("one");
    const result=relay.forward("one","/v1/read",new Request("http://fixture",{method:"POST",body:"{}"}));
    const id=(await relay.poll("one",connection.connectionId,[],new AbortController().signal)).requests[0]!.id;
    let cancelled=false;
    const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("first"));},cancel(){cancelled=true;}});
    const receipt=relay.respond("one",connection.connectionId,id,new Request("http://fixture/response",{method:"POST",headers:{"x-openteam-status":"200"},body:stream,duplex:"half"} as RequestInit));
    const reader=(await result).body!.getReader();expect((await reader.read()).done).toBe(false);
    const pending=reader.read().catch(error=>error as Error);
    relay.disconnect("one");expect((await pending as Error).message).toContain("disconnected");await receipt;expect(cancelled).toBe(true);
    const next=relay.connect("one");
    const failed=relay.forward("one","/v1/read",new Request("http://fixture",{method:"POST",body:"{}"})).catch(error=>error as Error);
    const failureId=(await relay.poll("one",next.connectionId,[],new AbortController().signal)).requests[0]!.id;
    relay.fail("one",next.connectionId,failureId);expect((await failed as Error).message).toContain("may have run");
  }finally{relay.close();}
});
