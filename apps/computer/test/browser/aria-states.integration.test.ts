import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('ARIA control states remain observable before and after clicks', async () => {
 const root=await mkdtemp(join(tmpdir(),'aria-states-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,args:process.platform==='linux'?['--no-sandbox']:[]});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(r:any):string=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<button aria-pressed="false" onclick="this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')==='true'?'false':'true')">Pin item</button>
   <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Show details</button>
   <div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">History</button></div>
   <div role="checkbox" aria-label="Include archived" aria-checked="mixed" tabindex="0"></div>
   <input type="checkbox" aria-label="Native checked" checked><input id="mixed" type="checkbox" aria-label="Native mixed">
   <button aria-pressed="mixed">Mixed toggle</button>
   <div role="checkbox" aria-label="Not checked" aria-checked="false" tabindex="0"></div>
   <style>[role=checkbox]{width:20px;height:20px}</style>`);
  await page.locator('#mixed').evaluate((el:HTMLInputElement) => {el.indeterminate=true;});
  const before=text(await session.execute('browser_snapshot',{}));
  const line=(snapshot:string,name:string)=>snapshot.split('\n').find(l=>l.includes(name))!;
  expect(line(before,'"Pin item"')).toContain('pressed=false');
  expect(line(before,'"Show details"')).toContain('expanded=false');
  expect(line(before,'"Overview"')).toContain('selected=true');
  expect(line(before,'"History"')).toContain('selected=false');
  expect(line(before,'"Include archived"')).toContain('checked=mixed');
  expect(line(before,'"Not checked"')).toContain('checked=false');
  expect(line(before,'"Native checked"')).toContain('checked');
  expect(line(before,'"Native mixed"')).toContain('checked=mixed');
  expect(line(before,'"Mixed toggle"')).toContain('pressed=mixed');
  await session.execute('browser_click',{ref:line(before,'"Pin item"').match(/\[ref=(e\d+)\]/)![1],element:'Pin item'});
  await session.execute('browser_click',{ref:line(before,'"Show details"').match(/\[ref=(e\d+)\]/)![1],element:'Show details'});
  const after=text(await session.execute('browser_snapshot',{}));
  expect(line(after,'"Pin item"')).toContain('pressed=true');
  expect(line(after,'"Show details"')).toContain('expanded=true');
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
