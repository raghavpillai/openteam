import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('hover reveals menu; console captures exceptions, bounds history and isolates tabs; snapshot marks non-editable controls', async () => {
 const root=await mkdtemp(join(tmpdir(),'hover-console-'));
 const server=Bun.serve({port:0,fetch:()=>new Response(`<style>#menu{display:none}#hover:hover #menu{display:block}</style><div id="hover" aria-label="Hover area">Hover area<button id="menu">Revealed menu</button></div><div role="textbox" aria-label="Static editor">unchanged</div><input readonly aria-label="Read only"><div>DIV-RECEIPT <span>COUNT-1</span></div><pre>PRE-RECEIPT</pre><output>OUTPUT-RECEIPT</output><script>console.error('fixture-secret original error');setTimeout(()=>{throw new Error('fixture exception')},10)</script>`,{headers:{'content-type':'text/html'}})});
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
 const context=await browser.newContext();
 const session=new (BrowserUseSession as any)(browser,context,root) as BrowserUseSession;
 const text=(result:any): string=>result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
 session.registerPrivateValues(['fixture-secret']);
 try {
  const state=text(await session.execute('browser_navigate',{url:`http://127.0.0.1:${server.port}`}));
  expect(state).toContain('DIV-RECEIPT'); expect(state).toContain('COUNT-1'); expect(state).toContain('PRE-RECEIPT'); expect(state).toContain('OUTPUT-RECEIPT'); expect(state).toMatch(/Static editor.*non-editable/); expect(state).toMatch(/Read only.*readonly/);
  const ref=state.split('\n').find(line=>line.includes('Hover area'))!.match(/\[ref=(e\d+)\]/)![1];
  expect(text(await session.execute('browser_hover',{target:ref}))).toContain('Revealed menu');
  await session.execute('browser_hover',{target:'#hover'});
  await expect(session.execute('browser_hover',{target:'input,div'})).rejects.toThrow('exactly one');
  const page=await (session as any).ensurePage();
  await page.evaluate(()=>{console.debug('debug-only');console.info('info-message')});
  await page.waitForTimeout(50);
  expect(text(await session.execute('browser_console_messages',{}))).not.toContain('debug-only');
  expect(text(await session.execute('browser_console_messages',{level:'debug'}))).toContain('debug-only');
  const errors=text(await session.execute('browser_console_messages',{level:'error'}));
  expect(errors).toContain('original error');expect(errors).toContain('fixture exception');expect(errors).toContain('http://127.0.0.1:');expect(errors).not.toContain('fixture-secret');
  expect(text(await session.execute('browser_console_messages',{}))).toContain('fixture exception');
  expect(text(await session.execute('browser_console_messages',{all:true}))).toContain('fixture exception');
  await page.evaluate(()=>{for(let i=0;i<250;i++)console.warn('entry-'+i)});
  await page.waitForTimeout(100);
  const bounded=await session.execute('browser_console_messages',{all:true});
  expect(bounded.details?.retained).toBe(200);expect(text(bounded)).not.toContain('entry-0\n');expect(text(bounded)).toContain('entry-249');
  await session.execute('browser_navigate',{url:'about:blank'});
  expect(text(await session.execute('browser_console_messages',{}))).toBe('No matching console messages.');
  expect(text(await session.execute('browser_console_messages',{all:true}))).toContain('entry-249');
  await session.execute('browser_navigate',{url:'about:blank',newTab:true});
  expect(text(await session.execute('browser_console_messages',{all:true}))).toBe('No matching console messages.');
 }finally{await browser.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},30_000);

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('waits observe delayed visibility, disappearance, timeout and cancellation without replaying actions', async () => {
 const root=await mkdtemp(join(tmpdir(),'browser-wait-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent('<div id="status" style="display:none">READY926</div>');
  await page.evaluate(()=>{setTimeout(()=>{document.querySelector<HTMLElement>('#status')!.style.display='block'},150)});
  await session.execute('browser_wait_for',{text:'READY926'});
  await page.evaluate(()=>{setTimeout(()=>{document.querySelector<HTMLElement>('#status')!.remove()},150)});
  await session.execute('browser_wait_for',{textGone:'READY926'});
  const started=Date.now(); await session.execute('browser_wait_for',{time:0.1}); expect(Date.now()-started).toBeGreaterThanOrEqual(90);
  for (const args of [{time:10},{text:'NEVER926'}]) {
   const controller=new AbortController(); const start=Date.now();
   const pending=session.execute('browser_wait_for',args,controller.signal);
   setTimeout(()=>controller.abort(new Error('New correction')),150);
   await expect(pending).rejects.toThrow('New correction'); expect(Date.now()-start).toBeLessThan(2000);
   await session.execute('browser_snapshot',{});
  }
  await expect(session.execute('browser_wait_for',{text:'NEVER926'})).rejects.toThrow('Timed out after 10000ms');
  for(const args of [{},{time:11},{time:-1},{time:NaN},{text:''}]) await expect(session.execute('browser_wait_for',args)).rejects.toThrow();
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('snapshot exposes focusable hover containers and inherited disabled state without hiding child controls', async () => {
 const root=await mkdtemp(join(tmpdir(),'browser-focusable-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(result:any):string=>result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<style>#menu{display:none}#hover:hover #menu{display:block}</style>
   <div id="hover" tabindex="0">Reviewer actions<div id="menu"><button onclick="document.querySelector('fieldset').disabled=false">Unlock form</button></div></div>
   <div tabindex="0"><div contenteditable="true" data-sand-secret-filled>focusable-private-value</div></div>
   <fieldset disabled><legend><input aria-label="Legend exception"></legend><label>Recipient<input></label><select aria-label="Region"><option>Europe</option></select></fieldset>`);
  session.registerPrivateValues(['focusable-private-value']);
  const state=text(await session.execute('browser_snapshot',{}));
  expect(state).not.toContain('focusable-private-value');
  expect(state).toMatch(/Reviewer actions.*\[ref=e\d+\]/);
  expect(state).toMatch(/Recipient" disabled/);
  expect(state).toMatch(/Region.*disabled/);
  expect(state).toMatch(/Legend exception.*\[ref=e\d+\]/);
  expect(state).not.toContain('Unlock form');
  const ref=state.split('\n').find(line=>line.includes('Reviewer actions'))!.match(/\[ref=(e\d+)\]/)![1];
  const hovered=text(await session.execute('browser_hover',{target:ref}));
  expect(hovered).toMatch(/button "Unlock form" \[ref=e\d+\]/);
  const button=hovered.split('\n').find(line=>line.includes('button "Unlock form"'))!.match(/\[ref=(e\d+)\]/)![1];
  const unlocked=text(await session.execute('browser_click',{ref:button}));
  expect(unlocked).toMatch(/Recipient.*\[ref=e\d+\]/);
  expect(unlocked).not.toMatch(/Recipient.*disabled/);
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
