import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Private immutable staging keeps file bytes outside JSON/tool history and bounds memory. */
export async function spoolFile(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, options: {signal?:AbortSignal; sizeBytes?:number; sha256?:string; maxBytes?:number} = {}) {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "openteam-transfer-"));
  const path = join(directory,"bytes");
  const cleanup = () => rm(directory,{recursive:true,force:true});
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let sizeBytes=0;
  const hash=createHash("sha256");
  try {
    file = await open(path,"wx",0o600);
    const chunks = async function* () {
      if ("getReader" in source) {
        const reader=source.getReader();
        const abort=()=>{void reader.cancel(options.signal?.reason).catch(()=>{});};
        options.signal?.addEventListener("abort",abort,{once:true});
        try {options.signal?.throwIfAborted();for(;;){const item=await reader.read();if(item.done)break;yield item.value;}}
        finally {options.signal?.removeEventListener("abort",abort);await reader.cancel().catch(()=>{});reader.releaseLock?.();}
      }
      else yield* source;
    };
    for await (const chunk of chunks()) {
      options.signal?.throwIfAborted();
      sizeBytes+=chunk.length;
      if(sizeBytes>(options.sizeBytes ?? options.maxBytes ?? Number.MAX_SAFE_INTEGER)) throw new Error("Transfer exceeds the declared size");
      hash.update(chunk); await file.writeFile(chunk);
    }
    options.signal?.throwIfAborted();
    const sha256=hash.digest("hex");
    if(options.sizeBytes!==undefined&&options.sizeBytes!==sizeBytes || options.sha256!==undefined&&options.sha256!==sha256) throw new Error("Staged file bytes changed after review");
    await file.sync();
    return {path,sizeBytes,sha256,cleanup};
  } catch(error) {await cleanup();throw error;}
  finally {await file?.close();}
}
export type StagedFile = Awaited<ReturnType<typeof spoolFile>>;
