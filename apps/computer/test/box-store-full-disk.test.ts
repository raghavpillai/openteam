import {test, expect, afterEach, mock} from "bun:test";
import {mkdtemp, mkdir, writeFile, readdir, rm, utimes} from "node:fs/promises";
import {basename, join} from "node:path";
import {tmpdir} from "node:os";
import * as manifestModule from "../src/box-store/manifest";

// A full disk is simulated by failing atomic writes whose target matches.
let full: ((path: string) => boolean) | null = null;
const realAtomicWrite = manifestModule.atomicWrite;
mock.module("../src/box-store/manifest", () => ({
 ...manifestModule,
 atomicWrite: async (path: string, bytes: Uint8Array, mode?: number) => {
  if (full?.(path)) throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path}'`), {code: "ENOSPC"});
  return realAtomicWrite(path, bytes, mode);
 },
}));
const {BLOB_RETENTION_MS, collectBoxStoreBlobsLocked, withBoxStoreOperation} = await import("../src/box-store/garbage-collection");
const {BoxStoreSync} = await import("../src/box-store-sync");
const {digest, manifestEtag} = manifestModule;
const roots:string[]=[];
afterEach(async()=>{full=null;await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'blob-gc-full-'));roots.push(root);await mkdir(join(root,'blobs'));return root;}
async function blob(root:string,text:string){const hash=digest(text);await writeFile(join(root,'blobs',hash),text);await utimes(join(root,'blobs',hash),new Date(0),new Date(0));return hash;}
async function manifest(root:string, hashes:string[]){
 const body={version:1 as const,revision:1,generatedAt:new Date().toISOString(),files:hashes.map((sha256,i)=>({path:`workspace/${i}`,sha256,size:1,mode:0o600}))};
 await writeFile(join(root,'manifest.json'),JSON.stringify({...body,etag:manifestEtag(body)}));
}
const sweep=(root:string, now:number)=>withBoxStoreOperation(root,()=>collectBoxStoreBlobsLocked(root,now));
test('one run deletes every expired orphan instead of stopping at a per-run cap',async()=>{
 const root=await fixture();const keep=await blob(root,'keep');await manifest(root,[keep]);
 await Promise.all(Array.from({length:5100},(_,i)=>blob(root,`orphan-${i}`)));
 const now=Date.now()+1000;expect((await sweep(root,now)).candidates).toBe(5100);
 expect((await sweep(root,now+BLOB_RETENTION_MS)).deleted).toBe(5100);
 expect(await readdir(join(root,'blobs'))).toEqual([keep]);
});
test('a full disk cannot stop collection or reset retention clocks',async()=>{
 const root=await fixture();await manifest(root,[]);await blob(root,'old');const now=Date.now()+1000;
 await sweep(root,now);
 const fresh=await blob(root,'fresh');full=path=>basename(path)==='.blob-gc-candidates.json';
 const first=await sweep(root,now+BLOB_RETENTION_MS);expect(first).toMatchObject({deleted:1,candidates:1});
 expect(await readdir(join(root,'blobs'))).toEqual([fresh]);
 const second=await sweep(root,now+2*BLOB_RETENTION_MS);expect(second.deleted).toBe(1);
 expect(await readdir(join(root,'blobs'))).toEqual([]);
});
test('collection still runs when a full disk fails the snapshot itself',async()=>{
 const root=await fixture();const home=join(root,'home'),sandRoot=join(home,'sand-data'),workspaceRoot=join(root,'workspace'),storeRoot=join(root,'store');
 await mkdir(sandRoot,{recursive:true});await mkdir(workspaceRoot,{recursive:true});await mkdir(join(storeRoot,'blobs'),{recursive:true});
 await manifest(storeRoot,[]);const orphan=await blob(storeRoot,'orphan');
 await writeFile(join(storeRoot,'.blob-gc-candidates.json'),JSON.stringify({version:1,candidates:{[orphan]:Date.now()-BLOB_RETENTION_MS-1000}}));
 await writeFile(join(workspaceRoot,'file'),'new content');full=path=>basename(path)!=='.blob-gc-candidates.json';
 const sync=new BoxStoreSync({home,sandRoot,workspaceRoot,storeRoot});
 await expect(sync.snapshotOut()).rejects.toThrow('ENOSPC');
 expect(await readdir(join(storeRoot,'blobs'))).toEqual([]);
});
