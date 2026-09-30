import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('delegated click containers retain independently actionable descendants', async () => {
 const root=await mkdtemp(join(tmpdir(),'interactive-descendants-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,args:process.platform==='linux'?['--no-sandbox']:[]});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(r:any):string=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<div onclick="void 0"><ul role="tablist"><li role="presentation" onclick="void 0"><a role="tab" href="#specs" onclick="document.title='specifications'">Specifications</a></li><li onclick="void 0"><a role="tab" href="#compat">Compatibility</a></li></ul></div><section onclick="void 0"><label>Quantity<input aria-label="Quantity"></label><button onclick="document.title='saved'">Save row</button><button hidden>Hidden action</button></section>`);
  await page.evaluate(() => {
    const host=document.createElement('div');host.setAttribute('onclick','void 0');host.style.display='block';host.attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';document.body.append(host);
    const outer=document.createElement('section');outer.setAttribute('onclick','void 0');const inner=document.createElement('div');inner.attachShadow({mode:'open'}).innerHTML='<button onclick="document.title=\'nested-shadow\'">Nested shadow action</button>';outer.append(inner);document.body.append(outer);
    const paragraph=document.createElement('p');paragraph.textContent='Account controls ';const widget=document.createElement('span');widget.attachShadow({mode:'open'}).innerHTML='<button>Nested paragraph action</button>';paragraph.append(widget);document.body.append(paragraph);
    const wrapper=document.createElement('div');wrapper.setAttribute('onclick','void 0');wrapper.innerHTML='<iframe srcdoc="<button>Frame action</button>"></iframe>';document.body.append(wrapper);
  });
  await page.frameLocator('iframe').getByRole('button',{name:'Frame action'}).waitFor();
  const snapshot=text(await session.execute('browser_snapshot',{}));
  const find=(name:string)=>snapshot.split('\n').find(l=>l.includes(name)&&l.includes('[ref='));
  const tab=find('tab "Specifications"');expect(tab).toBeDefined();
  expect(find('tab "Compatibility"')).toBeDefined();
  expect(find('textbox "Quantity"')).toBeDefined();
  expect(find('button "Save row"')).toBeDefined();
  expect(snapshot).not.toContain('Hidden action');
  expect(find('button "Shadow action"')).toBeDefined();
  expect(find('button "Frame action"')).toBeDefined();
  expect(find('button "Nested paragraph action"')).toBeDefined();
  const nested=find('button "Nested shadow action"');expect(nested).toBeDefined();
  await session.execute('browser_click',{ref:nested!.match(/\[ref=(e\d+)\]/)![1],element:'Nested shadow action'});
  expect(await page.title()).toBe('nested-shadow');
  await session.execute('browser_click',{ref:tab!.match(/\[ref=(e\d+)\]/)![1],element:'Specifications'});
  expect(await page.title()).toBe('specifications');
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
