import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('SVG controls remain discoverable and actionable', async () => {
 const root=await mkdtemp(join(tmpdir(),'svg-controls-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,args:process.platform==='linux'?['--no-sandbox']:[]});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(r:any):string=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<svg width="400" height="240" xmlns="http://www.w3.org/2000/svg">
   <g role="button" aria-label="Expand diagram" tabindex="0" onclick="document.title='expanded'"><rect x="10" y="10" width="120" height="40" fill="blue"/></g>
   <a href="#details"><text x="10" y="100">Diagram details</text></a>
   <g role="button" aria-label="Unavailable action" aria-disabled="true"><rect x="150" y="10" width="100" height="40"/></g>
   <g role="button" aria-label="Hidden diagram action" style="display:none"><rect width="100" height="40"/></g>
   <foreignObject x="10" y="130" width="200" height="60"><button xmlns="http://www.w3.org/1999/xhtml" onclick="document.title='embedded'">Embedded HTML action</button></foreignObject>
  </svg>`);
  const snapshot=text(await session.execute('browser_snapshot',{}));
  const line=(name:string)=>snapshot.split('\n').find(l=>l.includes(name));
  const button=line('button "Expand diagram"');expect(button).toContain('[ref=');
  const link=line('link "Diagram details"');expect(link).toContain('[ref=');
  expect(line('Unavailable action')).toContain('disabled');expect(line('Unavailable action')).not.toContain('[ref=');
  expect(snapshot).not.toContain('Hidden diagram action');
  const embedded=line('button "Embedded HTML action"');expect(embedded).toContain('[ref=');
  await session.execute('browser_click',{ref:button!.match(/\[ref=(e\d+)\]/)![1],element:'Expand diagram'});
  expect(await page.title()).toBe('expanded');
  await session.execute('browser_click',{ref:embedded!.match(/\[ref=(e\d+)\]/)![1],element:'Embedded HTML action'});
  expect(await page.title()).toBe('embedded');
  await session.execute('browser_click',{ref:link!.match(/\[ref=(e\d+)\]/)![1],element:'Diagram details'});
  expect(await page.evaluate(() => location.hash)).toBe('#details');
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
