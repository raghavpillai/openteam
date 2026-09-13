import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pluginCatalog } from '../../src';

const directory=await mkdtemp(join(tmpdir(),'google-mcp-smoke-'));
let count=0;
try {
 const mock=join(directory,'provider-fixture.ts');
 await writeFile(mock,`globalThis.fetch=async (input,init)=>{
  const url=new URL(input);
  if(url.pathname.endsWith('/drafts')&&init.method==='POST'){
   const raw=JSON.parse(init.body).message.raw;
   if(raw.length<10*1024*1024)throw new Error('Large draft transport fixture was unexpectedly small');
   return Response.json({id:'large-draft',message:{id:'large-message',threadId:'large-thread'}});
  }
  if(url.pathname.endsWith('/events'))return Response.json({items:[{id:'hiring',summary:'Recruiting discussion with hiring manager',etag:'v1'}],nextSyncToken:'sync'});
  if(url.pathname.endsWith('/files/large')&&url.searchParams.get('alt')==='media')return new Response('complete document '.repeat(10000));
  if(url.pathname.endsWith('/files/large'))return Response.json({id:'large',name:'large.txt',mimeType:'text/plain',size:'180000'});
  throw new Error('Unexpected fixture destination '+url.pathname);
 };`);
 for(const [key,expected,read] of [['gmail',26,'list_labels'],['google-calendar',10,'list_calendars'],['google-drive',9,'list_recent_files']] as const){
  const root=join(directory,key),pkg=pluginCatalog.find(p=>p.key===key)!;
  for(const [path,text] of Object.entries(pkg.files??{})){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);}
  for(const [path,base64] of Object.entries(pkg.binaryFiles??{})){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),Buffer.from(base64,'base64'));}
  const entry=join(root,'connector/server.mjs');
  let stderr='';
  const client=new Client({name:'package-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],cwd:root,env:{GOOGLE_ACCESS_TOKEN:''},stderr:'pipe'});
  transport.stderr?.on('data',data=>{stderr+=String(data);});
  try{
   await client.connect(transport);
   const tools=(await client.listTools()).tools;assert.equal(tools.length,expected);count+=tools.length;
   const invalid=await client.callTool({name:read,arguments:{unexpected:true}});assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/Invalid tool arguments/);
   const unauthorized=await client.callTool({name:read,arguments:{}});assert.equal(unauthorized.isError,true);assert.match(JSON.stringify(unauthorized),/not authorized/);
  }catch(error){throw new Error(key+': '+String(error)+'\n'+stderr);}finally{await client.close();}
  const connected=new Client({name:'package-fixture',version:'1.0.0'});
  const fixture=new StdioClientTransport({command:process.execPath,args:['--preload',mock,entry],cwd:root,env:{GOOGLE_ACCESS_TOKEN:'synthetic-token',OPENTEAM_PLUGIN_ACCOUNT_ID:'smoke-account-'+key},stderr:'pipe'});
  fixture.stderr?.on('data',data=>{stderr+=String(data);});
  try{
   await connected.connect(fixture);
   const call=async(name:string,args:any)=>{const result=await connected.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse((result.content as any)[0].text);};
   if(key==='gmail')assert.equal((await call('create_draft',{subject:'Large binary transport fixture',attachments:[{filename:'large.bin',mimeType:'application/octet-stream',content:Buffer.alloc(9*1024*1024,42).toString('base64')}]})).id,'large-draft');
   else if(key==='google-calendar')assert.equal((await call('search_events',{query:'interviewing job candidates'})).events[0].id,'hiring');
   else{
    let page=await call('read_file_content',{fileId:'large'}),json='';assert.ok(page.resultId);
    while(true){json+=page.jsonFragment;if(page.nextOffset===null)break;page=await call('read_result',{resultId:page.resultId,offset:page.nextOffset});}
    assert.equal(JSON.parse(json).fileContent,'complete document '.repeat(10000));
   }
  }catch(error){throw new Error(key+': '+String(error)+'\n'+stderr);}finally{await connected.close();}
 }
 const report=JSON.stringify({plugins:3,schemas:count,offlineSemanticSearch:true,pagedResult:true});
 if(process.argv[2])await Bun.write(process.argv[2],report);
 else console.log(report);
}finally{await rm(directory,{recursive:true,force:true});}
