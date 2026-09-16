import {expect,test} from "bun:test";
import {mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spoolFile} from "@openteam/plugin-sdk/file-spool";
import {agentWriteStream} from "../src/agent-file-stream";

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
