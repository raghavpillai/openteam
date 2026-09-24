import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetStore } from "../src/asset-store";

test("empty bytes, streams and file attachments survive storage and contract validation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"empty-asset-"));
  try {
    const store=new AssetStore({root:join(root,"assets"),allowedFileRoots:[root]});
    const file=join(root,"empty.txt");await writeFile(file,"");
    const bytes=await store.ingestBytes({fileName:"bytes.txt",bytes:new Uint8Array()});
    const stream=await store.ingestStream({fileName:"stream.txt",stream:(async function*(){})()});
    const source=await store.ingestSource({url:pathToFileURL(file).href});
    for(const ref of [bytes,stream,source]) {
      expect(ref.byteSize).toBe(0);
      expect((await store.metadata(ref.assetId)).byteSize).toBe(0);
      expect((await readFile(store.contentPath(ref.assetId))).length).toBe(0);
    }
    expect(new Set([bytes.assetId,stream.assetId,source.assetId]).size).toBe(1);
  } finally {await rm(root,{recursive:true,force:true});}
});
