import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';
test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('batch fills text and checkbox states, and stops after unavailable targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'batch-form-'));
 const server=Bun.serve({port:0,fetch:()=>new Response('<html><title>Batch</title><input aria-label="Name"><textarea aria-label="Notes"></textarea><input type="checkbox" aria-label="Checked" checked><input type="checkbox" aria-label="Unchecked"><input type="password" aria-label="Password"><button>Submit</button></html>',{headers:{'content-type':'text/html'}})});
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
 const context=await browser.newContext();
 const session=new (BrowserUseSession as any)(browser,context,root) as BrowserUseSession;
 try {
  const result=await session.execute('browser_navigate',{url:`http://127.0.0.1:${server.port}`});
  const text=result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
  const ref=(label:string)=>text.split('\n').find(line=>line.includes(`"${label}"`)&&line.includes('[ref='))!.match(/\[ref=(e\d+)\]/)![1]!;
  const fields=[{target:ref('Name'),name:'Name',type:'textbox',value:'Parity926'},{target:ref('Notes'),name:'Notes',type:'textbox',value:'Line one\nLine two'},{target:ref('Checked'),name:'Checked',type:'checkbox',value:'false'},{target:ref('Unchecked'),name:'Unchecked',type:'checkbox',value:true}];
  const filled=await session.execute('browser_fill_form',{fields});
  expect((filled as any).isError).toBe(false);
  const page=await (session as any).ensurePage();
  expect(await page.getByLabel('Notes').inputValue()).toBe('Line one\nLine two');
  expect(await page.getByLabel('Checked',{exact:true}).isChecked()).toBe(false);
  expect(await page.getByLabel('Unchecked',{exact:true}).isChecked()).toBe(true);
  expect(((await session.execute('browser_fill_form',{fields})) as any).isError).toBe(false);
  expect(await page.getByLabel('Checked',{exact:true}).isChecked()).toBe(false);
  const failed=await session.execute('browser_fill_form',{fields:[{target:ref('Password'),name:'Password',type:'textbox',value:'dummy'},{...fields[0],value:'must not run'}]});
  expect((failed as any).isError).toBe(true);
  expect((failed.details as any).fields.map((f:any)=>f.status)).toEqual(['failed','not_attempted']);
  expect(await page.getByLabel('Name',{exact:true}).inputValue()).toBe('Parity926');
  expect(await page.getByLabel('Password').inputValue()).toBe('');
  await expect(session.execute('browser_fill_form',{fields:[fields[0],fields[0]]})).rejects.toThrow('unique');
  await page.getByLabel('Name',{exact:true}).evaluate((node:any)=>node.addEventListener('input',()=>document.querySelector('textarea')!.remove(),{once:true}));
  const changed=await session.execute('browser_fill_form',{fields:[{...fields[0],value:'page changes'},fields[1],fields[2]]});
  expect((changed.details as any).fields.map((f:any)=>f.status)).toEqual(['filled','failed','not_attempted']);
  await page.getByLabel('Name',{exact:true}).evaluate((node:any)=>node.remove());
  await expect(session.execute('browser_fill_form',{fields:[fields[0]]})).rejects.toThrow('stale');
 } finally {await browser.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},30_000);
