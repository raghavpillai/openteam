import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {agentFileIO} from '../src/agent-file-io';
import {NativeToolExecutor} from '../src/native-tool-executor';

test('Read rejects a file swapped into protected state after its initial readability check',async()=>{
 const root=await mkdtemp('/tmp/read-race-');
 try {
  const data=root+'/data';await mkdir(data);
  const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
  const target=root+'/ordinary.txt';await writeFile(target,'public');
  const ex=new NativeToolExecutor({agentDir:root+'/runtime',controlToken:'fixture',agentDataCanonicalRoot:data});
  await expect(ex.read({path:secret},root)).rejects.toThrow('protected agent-data');
  const check=(ex as any).assertAgentReadable.bind(ex);
  (ex as any).assertAgentReadable=async(path:string)=>{await check(path);if(path===target){await rm(target);await symlink(secret,target)}};
  await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Read allows an ordinary atomic replacement and recovers after missing old name',async()=>{
 const root=await mkdtemp('/tmp/read-replace-');
 try {
  const target=root+'/draft.txt';await writeFile(target,'OLD');
  const replacement=root+'/new.txt';await writeFile(replacement,'café 日本語\r\nNEW');
  const ex=new NativeToolExecutor({agentDir:root+'/runtime',controlToken:'fixture'});
  const check=(ex as any).assertAgentReadable.bind(ex);let replaced=false;
  (ex as any).assertAgentReadable=async(path:string)=>{await check(path);if(!replaced){await rename(replacement,target);replaced=true}};
  const result=await ex.read({path:target},root);
  expect(JSON.stringify(result)).toContain('café 日本語');
  expect(result.details.fileSize).toBe(Buffer.byteLength('café 日本語\r\nNEW'));
  const renamed=root+'/résumé 日本語 #1.txt';await rename(target,renamed);
  expect((await ex.read({path:target},root) as any).isError).toBe(true);
  expect(JSON.stringify(await ex.read({path:renamed},root))).toContain('NEW');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Privileged terminal exception rejects an opened descriptor redirected outside logs',async()=>{
 const root=await mkdtemp('/tmp/read-log-');
 try {
  const data=root+'/data';await mkdir(data);await mkdir(root+'/terminals');
  const secret=data+'/settings.json';await writeFile(secret,'DUMMY-PRIVATE-CANARY');
  const target=root+'/terminals/123456.log';await writeFile(target,'log');
  const ex=new NativeToolExecutor({agentDir:root,controlToken:'fixture',agentDataCanonicalRoot:data});
  expect(JSON.stringify(await ex.read({path:target},root))).toContain('log');
  const check=(ex as any).assertProtectedReadPath.bind(ex);let swapped=false;
  (ex as any).assertProtectedReadPath=async(path:string)=>{await check(path);if(!swapped){swapped=true;await rm(target);await symlink(secret,target)}};
  await expect(ex.read({path:target},root)).rejects.toThrow('protected agent-data');
 }finally{await rm(root,{recursive:true,force:true})}
});


test('Read rejects a regular file replaced by a FIFO without waiting for a writer',async()=>{
 const root=await mkdtemp('/tmp/read-fifo-');
 try {
  for(const terminal of [false,true]) {
   const runtime=root+(terminal?'/terminal-case':'/ordinary-case');await mkdir(runtime+'/terminals',{recursive:true});
   const target=runtime+(terminal?'/terminals/123456.log':'/ordinary.txt');await writeFile(target,'before');
   const ex=new NativeToolExecutor({agentDir:runtime,controlToken:'fixture'});
   const method=terminal?'assertProtectedReadPath':'assertAgentReadable';
   const check=(ex as any)[method].bind(ex);let swapped=false;
   (ex as any)[method]=async(path:string)=>{await check(path);if(!swapped){swapped=true;await rm(target);execFileSync('mkfifo',[target])}};
   await expect(ex.read({path:target},root)).rejects.toThrow(/regular file|Not a file/);
   await expect(agentFileIO('read',target)).rejects.toThrow('regular file');
  }
 }finally{await rm(root,{recursive:true,force:true})}
},3000);
