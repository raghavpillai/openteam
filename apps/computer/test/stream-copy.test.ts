import {test,expect} from "bun:test";
import {createServer} from "node:http";
import {mkdtemp,open,rm,readFile,readdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {HostFileTransfers} from "../../desktop/src/main/host/file-transfer";
import {agentReadStream,agentWriteStream} from "../src/agent-file-stream";
import {spoolFile} from "@openteam/plugin-sdk/file-spool";

test("host and box stream a file above 256 MiB, with single-use permits and atomic failure",async()=>{
 const root=await mkdtemp(join(tmpdir(),"stream-copy-fixture-"));
 const source=join(root,"source.bin"),box=join(root,"box.bin"),destination=join(root,"host.bin");
 const transfers=new HostFileTransfers();
 const server=createServer(async(request,response)=>{try{await transfers.transfer(request.url!.slice(1),request,response);}catch(error){if(response.headersSent)response.destroy();else{response.statusCode=400;response.end(String(error));}}});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
  const file=await open(source,"wx");await file.truncate(257*1024*1024+7);await file.write(Buffer.from("start"),0,5,0);await file.write(Buffer.from("ending"),0,6,257*1024*1024+1);await file.close();
  const permit=await transfers.prepare({direction:"read",path:source,machineId:"fixture"});
  const response=await fetch(`${base}/${permit.transferId}`);
  expect(await agentWriteStream(box,response.body!)).toBe(257*1024*1024+7);
  expect((await fetch(`${base}/${permit.transferId}`)).status).toBe(400);
  const staged=await spoolFile(Bun.file(box).stream());
  try {
   const original=await spoolFile(Bun.file(source).stream());try{expect(staged.sha256).toBe(original.sha256);}finally{await original.cleanup();}
   const write=await transfers.prepare({direction:"write",path:destination,bytes:staged.sizeBytes,machineId:"fixture"});
   const input=agentReadStream(box);
   try {expect((await fetch(`${base}/${write.transferId}`,{method:"PUT",body:Readable.toWeb(input.stream) as any,duplex:"half"} as any)).ok).toBe(true);await input.done;}finally{input.cancel();}
   const copied=await spoolFile(Bun.file(destination).stream());try{expect(copied.sha256).toBe(staged.sha256);}finally{await copied.cleanup();}
  }finally{await staged.cleanup();}
  await writeFile(destination,"preserved");
  const incomplete=await transfers.prepare({direction:"write",path:destination,bytes:20,machineId:"fixture"});
  expect((await fetch(`${base}/${incomplete.transferId}`,{method:"PUT",body:"short"})).status).toBe(400);
  expect(await readFile(destination,"utf8")).toBe("preserved");
  expect((await readdir(root)).filter(name=>name.startsWith(".openteam-transfer"))).toEqual([]);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
},60_000);
