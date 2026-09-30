import {test, expect, afterEach} from "bun:test";
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BLOB_RETENTION_MS, collectBoxStoreBlobsLocked, withBoxStoreOperation} from "../src/box-store/garbage-collection";
import {digest, manifestEtag} from "../src/box-store/manifest";
import {BoxStoreSync} from "../src/box-store-sync";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'blob-gc-'));roots.push(root);await mkdir(join(root,'blobs'));return root;}
async function blob(root:string,text:string){const hash=digest(text);await writeFile(join(root,'blobs',hash),text);return hash;}
async function manifest(root:string, hashes:string[], name='manifest.json'){
 const body={version:1 as const,revision:1,generatedAt:new Date().toISOString(),files:hashes.map((sha256,i)=>({path:`workspace/${i}`,sha256,size:1,mode:0o600}))};
 await writeFile(join(root,name),JSON.stringify({...body,etag:manifestEtag(body)}));
}
const sweep=(root:string, now:number)=>withBoxStoreOperation(root,()=>collectBoxStoreBlobsLocked(root,now));
test('old blobs get a full observation grace period; current and conflict roots survive',async()=>{
 const root=await fixture(), current=await blob(root,'current'), conflict=await blob(root,'conflict'), orphan=await blob(root,'orphan');
 const now=Date.now()+1000;
 for(const hash of [current,conflict,orphan])await utimes(join(root,'blobs',hash),new Date(0),new Date(0));
 await manifest(root,[current]);await manifest(root,[conflict],'conflict.manifest-1.json');
 expect((await sweep(root,now)).deleted).toBe(0);
 expect((await sweep(root,now+BLOB_RETENTION_MS-1)).deleted).toBe(0);
 const result=await sweep(root,now+BLOB_RETENTION_MS);expect(result.deleted).toBe(1);expect(result.deletedBytes).toBe(6);
 expect((await readdir(join(root,'blobs'))).sort()).toEqual([current,conflict].sort());
 const workspaceRoot=join(root,'restored');const sync=new BoxStoreSync({storeRoot:root,home:join(root,'home'),sandRoot:join(root,'sand'),workspaceRoot});
 expect(await sync.copyIn()).toEqual({copied:1,skipped:0});expect(await readFile(join(workspaceRoot,'0'),'utf8')).toBe('current');
});
test('reference return, blob rewrite and backwards clocks restart retention',async()=>{
 const root=await fixture(), hash=await blob(root,'same');const now=Date.now()+1000;await manifest(root,[]);await sweep(root,now);
 await manifest(root,[hash]);await sweep(root,now+BLOB_RETENTION_MS);await manifest(root,[]);
 expect((await sweep(root,now+BLOB_RETENTION_MS+1)).deleted).toBe(0);
 const rewrite=now+2*BLOB_RETENTION_MS;await utimes(join(root,'blobs',hash),new Date(rewrite),new Date(rewrite));
 expect((await sweep(root,rewrite+1)).deleted).toBe(0);
 expect((await sweep(root,now)).deleted).toBe(0);
 expect(await readFile(join(root,'blobs',hash),'utf8')).toBe('same');
});
test('missing or malformed roots and candidate state never permit deletion; symlinks are not followed',async()=>{
 const root=await fixture(), hash=await blob(root,'keep');const now=Date.now()+1000;
 expect((await sweep(root,now)).scanned).toBe(0);
 await manifest(root,[]);await sweep(root,now);
 await writeFile(join(root,'conflict.manifest-2.json'),'{}');
 await expect(sweep(root,now+BLOB_RETENTION_MS)).rejects.toThrow('invalid manifest');expect(await readFile(join(root,'blobs',hash),'utf8')).toBe('keep');
 await rm(join(root,'conflict.manifest-2.json'));
 await writeFile(join(root,'.blob-gc-candidates.json'),'{}');await expect(sweep(root,now+BLOB_RETENTION_MS)).rejects.toThrow('candidate state');
 await rm(join(root,'.blob-gc-candidates.json'));await writeFile(join(root,'outside'),'private');await symlink(join(root,'outside'),join(root,'blobs','a'.repeat(64)));
 await sweep(root,now);await sweep(root,now+BLOB_RETENTION_MS);expect(await readFile(join(root,'outside'),'utf8')).toBe('private');
});
test('separate operations serialize and release their lock after an exception',async()=>{
 const root=await fixture();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const order:string[]=[];
 const first=withBoxStoreOperation(root,async()=>{order.push('first');entered.resolve();await release.promise;throw new Error('fixture failure');}).catch(()=>{});
 await entered.promise;const second=withBoxStoreOperation(root,async()=>{order.push('second');});
 await new Promise(resolve=>setTimeout(resolve,60));expect(order).toEqual(['first']);release.resolve();await Promise.all([first,second]);expect(order).toEqual(['first','second']);
});
test('another process holds the lock and process death releases it without stealing',async()=>{
 const root=await fixture();const modulePath=process.env.OPENTEAM_TEST_GC_MODULE ?? new URL('../src/box-store/garbage-collection.ts',import.meta.url).href;
 const child=Bun.spawn([process.execPath,'-e',`import {withBoxStoreOperation} from ${JSON.stringify(modulePath)}; await withBoxStoreOperation(${JSON.stringify(root)},async()=>{console.log('LOCKED');await new Promise(()=>{});});`],{stdout:'pipe',stderr:'pipe'});
 try {
  const reader=child.stdout.getReader();const chunk=await reader.read();expect(new TextDecoder().decode(chunk.value)).toContain('LOCKED');reader.releaseLock();
  let acquired=false;const next=withBoxStoreOperation(root,async()=>{acquired=true;});
  await new Promise(resolve=>setTimeout(resolve,60));expect(acquired).toBe(false);child.kill('SIGKILL');await child.exited;await next;expect(acquired).toBe(true);
 }finally{child.kill();await child.exited;}
},5000);
test('snapshot reintroducing a previously orphaned hash refreshes its retention age',async()=>{
 const root=await fixture();const home=join(root,'home'),sandRoot=join(home,'sand-data'),workspaceRoot=join(root,'workspace'),storeRoot=join(root,'store');
 await mkdir(sandRoot,{recursive:true});await mkdir(workspaceRoot,{recursive:true});
 const sync=new BoxStoreSync({home,sandRoot,workspaceRoot,storeRoot});const file=join(workspaceRoot,'file');await writeFile(file,'original');const first=await sync.snapshotOut();const hash=first.files.find(f=>f.path==='workspace/file')!.sha256;
 await writeFile(file,'replacement');await sync.snapshotOut();const now=Date.now();
 await utimes(join(storeRoot,'blobs',hash),new Date(0),new Date(0));await writeFile(join(storeRoot,'.blob-gc-candidates.json'),JSON.stringify({version:1,candidates:{[hash]:now-BLOB_RETENTION_MS-1000}}));
 await writeFile(file,'original');await sync.snapshotOut();await writeFile(file,'replacement');await sync.snapshotOut();
 expect((await sweep(storeRoot,Date.now()+10)).deleted).toBe(0);expect(await readFile(join(storeRoot,'blobs',hash),'utf8')).toBe('original');
});
