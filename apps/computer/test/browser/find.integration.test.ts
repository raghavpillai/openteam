import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';
import {findPageLines} from '../../src/browser/find';

test('find validates queries, bounds context and times out pathological regex', async () => {
  for (const args of [{}, {text:'x',regex:'y'}, {regex:'['}, {text:''}, {text:'x',maxResults:0}])
    await expect(findPageLines([], args)).rejects.toThrow();
  const result = await findPageLines(['before', 'Needle', 'after', 'needle'], {regex:'/needle/i',maxResults:1});
  expect(result.count).toBe(2); expect(result.truncated).toBe(true); expect(result.lines).toContain('1: before');
  // Engines may bound backtracking themselves; either no match or our timeout is valid.
  try { expect((await findPageLines(['a'.repeat(10000)+'!'], {regex:'(a+)+$'})).count).toBe(0); }
  catch (error) { expect(String(error)).toContain('time limit'); }
});

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('find recovers generic text, shadow/frame content and actionable refs; typing rejects non-editable targets without clicking', async () => {
 const root=await mkdtemp(join(tmpdir(),'find-browser-'));
 const server=Bun.serve({port:0,fetch:()=>new Response(`<html><body>
 <div>Scope of delivery</div><span>Original box and original papers</span>
 <div hidden>Hidden needle</div><div id="shadow"></div>
 <iframe srcdoc='<span>Frame needle</span><button>Frame action</button>'></iframe>
 <a href="/wrong">Navigate away</a><button onclick="document.title='clicked'">Load all listings</button>
 <input aria-label="Writable"><input aria-label="Read only" readonly><input aria-label="Password" type="password" value="secret-needle">
 <div contenteditable="true" aria-label="Editor">editable</div>
 <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span>Shadow needle</span>';</script>
 </body></html>`,{headers:{'content-type':'text/html'}})});
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
 const context=await browser.newContext();
 const session=new (BrowserUseSession as any)(browser,context,root) as BrowserUseSession;
 const text=(result:any)=>result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
 const ref=(value:string,label:string)=>value.split('\n').find(line=>line.includes(label)&&line.includes('[ref='))!.match(/\[ref=(e\d+)\]/)![1]!;
 try {
  await session.execute('browser_navigate',{url:`http://127.0.0.1:${server.port}`});
  const found=text(await session.execute('browser_find',{regex:'/original|needle|Load all/i'}));
  expect(found).toContain('Original box and original papers');
  expect(found).toContain('Scope of delivery');
  expect(found).toContain('Shadow needle'); expect(found).toContain('Frame needle');
  expect(found).not.toContain('Hidden needle'); expect(found).not.toContain('secret-needle');
  await session.execute('browser_click',{ref:ref(found,'Load all')});
  const page=await (session as any).ensurePage(); expect(await page.title()).toBe('clicked');
  let state=text(await session.execute('browser_snapshot',{}));
  for(const label of ['Navigate away','Read only','Load all']) {
    await expect(session.execute('browser_type',{ref:ref(state,label),text:'wrong',submit:true})).rejects.toThrow('editable');
    expect(page.url()).toBe(`http://127.0.0.1:${server.port}/`);
  }
  await session.execute('browser_type',{ref:ref(state,'Writable'),text:'correct'});
  expect(await page.getByLabel('Writable').inputValue()).toBe('correct');
  state=text(await session.execute('browser_snapshot',{}));
  await session.execute('browser_type',{ref:ref(state,'Editor'),text:'replacement',clear:true});
  expect(await page.getByLabel('Editor').innerText()).toBe('replacement');
  expect((await session.execute('browser_find',{text:'absent unique phrase'})).details?.matches).toBe(0);
  await page.evaluate(() => {
    const section = document.createElement('section');
    section.innerHTML = '<p>Ordinary row</p>'.repeat(450) + '<div>Late needle <button>Late action</button></div>';
    document.body.append(section);
  });
  const late = text(await session.execute('browser_find', {text:'Late needle'}));
  expect(late).toContain('Late needle');
  expect(late).toContain('Late action');
 }finally{await browser.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},30_000);
