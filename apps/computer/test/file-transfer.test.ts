import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { HostFileTransfers } from "../../desktop/src/main/host/file-transfer";
import { AGENT_FILE_IO_SCRIPT } from "../src/agent-file-io";
import { agentReadStream, agentWriteStream } from "../src/agent-file-stream";
import { nodeBinary } from "../src/node-runtime";

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
   const original=await spoolFile(Bun.file(source).stream());try{expect(staged.sizeBytes).toBe(original.sizeBytes);expect(staged.sha256).toBe(original.sha256);}finally{await original.cleanup();}
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

test("cancelled stalled transfers release the source and preserve the previous file",async()=>{
 const root=await mkdtemp(join(tmpdir(),"cancel-transfer-"));const path=join(root,"saved.bin");
 try {
  await writeFile(path,"original");
  for(const writer of [false,true]) {
   const abort=new AbortController();let cancelled=false;
   const source=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2,3]));},cancel(){cancelled=true;}});
   const operation=writer ? agentWriteStream(path,source,abort.signal) : spoolFile(source,{signal:abort.signal});
   const rejected=operation.then(()=>false,()=>true);
   await Bun.sleep(80);abort.abort();
   expect(await rejected).toBe(true);expect(cancelled).toBe(true);
   expect(await readFile(path,"utf8")).toBe("original");
   expect(await readdir(root)).toEqual(["saved.bin"]);
  }
 }finally{await rm(root,{recursive:true,force:true});}
},10_000);

test("incomplete or altered pipe data cannot replace an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-integrity-"));
  const path = join(root, "destination");
  const original = "complete payload with a final partial chunk";
  const receipt = JSON.stringify({
    bytes: Buffer.byteLength(original),
    sha256: createHash("sha256").update(original).digest("hex"),
  });
  try {
    for (const payload of [
      original.slice(0, -7),
      original.replace("complete", "modified"),
      original,
    ]) {
      await writeFile(path, "preserved");
      const child = spawn(
        nodeBinary(),
        ["-e", AGENT_FILE_IO_SCRIPT, "write", path, "1048576", "verify"],
        { stdio: ["pipe", "pipe", "pipe", "pipe"] }
      );
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stderr.resume();
      child.stdout.resume();
      child.stdin.end(payload);
      (child.stdio[3] as Writable).end(receipt);
      expect(await closed).toBe(payload === original ? 0 : 1);
      expect(await readFile(path, "utf8")).toBe(payload === original ? original : "preserved");
      expect(await readdir(root)).toEqual(["destination"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
