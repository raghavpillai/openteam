import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('native numeric control constraints remain observable after keyboard changes', async () => {
 const root=await mkdtemp(join(tmpdir(),'native-range-bounds-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,args:process.platform==='linux'?['--no-sandbox']:[]});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(r:any):string=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
 const line=(snapshot:string,name:string)=>snapshot.split('\n').find(l=>l.includes(JSON.stringify(name)))!;
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<input type="range" aria-label="Volume" value="30" min="10" max="90" step="5">
   <input type="number" aria-label="Quantity" value="3" min="1" max="12" step="1">
   <input type="number" aria-label="Continuous" value="0.5" min="-2.5" max="1e2" step="any">
   <input type="range" aria-label="Invalid" min="" max="Infinity" step="0">
   <input type="number" aria-label="Malformed" min="0x10" max="0b11" step="-5">
   <input type="range" aria-label="Implicit defaults">
   <input type="number" aria-label="Private bounds" data-sand-secret-filled="true" value="7391" min="7380" max="7400" step="2">`);
  const before=text(await session.execute('browser_snapshot',{}));
  expect(line(before,'Volume')).toContain('min="10" max="90" step="5"');
  expect(line(before,'Quantity')).toContain('min="1" max="12" step="1"');
  expect(line(before,'Continuous')).toContain('min="-2.5" max="1e2" step="any"');
  expect(line(before,'Invalid')).not.toMatch(/ (min|max|step)=/);
  expect(line(before,'Malformed')).not.toMatch(/ (min|max|step)=/);
  expect(line(before,'Implicit defaults')).not.toMatch(/ (min|max|step)=/);
  expect(before).not.toContain('7391');expect(before).not.toContain('7380');expect(before).not.toContain('7400');
  expect(line(before,'Private bounds')).toContain('min="<redacted>" max="<redacted>" step="<redacted>"');
  await page.getByRole('slider',{name:'Volume',exact:true}).press('ArrowRight');
  const after=text(await session.execute('browser_snapshot',{}));
  expect(line(after,'Volume')).toContain('value="35"');
  expect(line(after,'Volume')).toContain('min="10" max="90" step="5"');
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
