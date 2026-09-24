import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../src/browser/use';
import {outOfProcessPlaywright} from '../src/browser/playwright-driver';
const executable=process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;if(!executable)throw Error('Set OPENTEAM_BROWSER_TEST_EXECUTABLE');
const root=await mkdtemp(join(tmpdir(),'browser-upload-'));const workspace=join(root,'workspace');await mkdir(workspace);
const file=join(workspace,'résumé #1.txt');await writeFile(file,'café 日本語\n');
const outside=join(root,'outside.txt');await writeFile(outside,'outside');await symlink(outside,join(workspace,'alias.txt'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<label>Upload<input type=file multiple></label>',{headers:{'content-type':'text/html'}})});
const chrome=spawn(executable,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${join(root,'profile')}`],{stdio:'ignore'});
let driver:any;
try {
 let port='';for(let n=0;n<80;n++){try{port=(await readFile(join(root,'profile/DevToolsActivePort'),'utf8')).split('\n')[0]!;break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.ok(port);const s=await BrowserUseSession.connect(`http://127.0.0.1:${port}`,join(root,'shots'));s.configureUploads(workspace);driver=await outOfProcessPlaywright();
 await s.execute('browser_navigate',{url:server.url.href});
 const page=await (s as any).ensurePage();
 const open=async()=>{const state=await s.execute('browser_snapshot',{});const text=state.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n');const ref=text.match(/\[ref=(e\d+)\]/)![1];const r=await s.execute('browser_click',{ref});assert.equal(r.details.pendingFileChooser,true);};
 await open();await s.execute('browser_file_upload',{});assert.equal(await page.locator('input').evaluate((e:HTMLInputElement)=>e.files?.length),0);
 await open();await assert.rejects(s.execute('browser_file_upload',{paths:[outside]}),/outside/);
 await assert.rejects(s.execute('browser_file_upload',{paths:[join(workspace,'alias.txt')]}),/changed|private/);
 await s.execute('browser_file_upload',{paths:[file]});
 assert.deepEqual(await page.locator('input').evaluate(async(e:HTMLInputElement)=>({name:e.files![0]!.name,text:await e.files![0]!.text(),type:e.files![0]!.type})),{name:'résumé #1.txt',text:'café 日本語\n',type:'text/plain;charset=utf-8'});
 await open();const observed=await s.uploadReviewTarget({});await page.reload();await assert.rejects(s.assertUploadReviewTarget({},observed),/chooser|changed/);await assert.rejects(s.execute('browser_file_upload',{paths:[file]}),/chooser/);
 console.log('PASS dedicated upload: cancel, Unicode bytes, root/symlink denial, recovery, stale navigation');
} finally {server.stop(true);const exited=chrome.exitCode===null?once(chrome,'exit'):Promise.resolve();chrome.kill('SIGKILL');await exited;await driver?.stop();await rm(root,{recursive:true,force:true});}
