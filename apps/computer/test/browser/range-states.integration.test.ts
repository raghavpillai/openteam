import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserUseSession} from '../../src/browser/use';
import {outOfProcessPlaywright} from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('custom range values expose actual transitions and preserve private-value redaction', async () => {
 const root=await mkdtemp(join(tmpdir(),'range-states-'));
 const driver=await outOfProcessPlaywright();
 const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,args:process.platform==='linux'?['--no-sandbox']:[]});
 const session=new (BrowserUseSession as any)(browser,await browser.newContext(),root) as BrowserUseSession;
 const text=(r:any):string=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
 const line=(snapshot:string,name:string)=>snapshot.split('\n').find(l=>l.includes(JSON.stringify(name)))!;
 try {
  await session.execute('browser_navigate',{url:'about:blank'});
  const page=await (session as any).ensurePage();
  await page.setContent(`<div role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40" aria-valuetext="40 percent" onkeydown="if(event.key==='ArrowRight'){this.setAttribute('aria-valuenow','50');this.setAttribute('aria-valuetext','50 percent')}">Volume</div>
   <div role="spinbutton" tabindex="0" aria-label="Quantity" aria-valuenow="3" aria-valuemin="1" aria-valuemax="10">Quantity</div>
   <div role="slider" tabindex="0" aria-label="Invalid" aria-valuenow="unknown" aria-valuemin="" aria-valuemax="Infinity">Invalid</div>
   <div role="slider" tabindex="0" aria-label="Private" data-sand-secret-filled="true" aria-valuenow="7391" aria-valuetext="private sentinel">Private</div>
   <input type="range" aria-label="Native volume" value="30" min="0" max="100">`);
  const before=text(await session.execute('browser_snapshot',{}));
  expect(line(before,'Volume')).toContain('valuenow="40"');
  expect(line(before,'Volume')).toContain('valuemin="0"');
  expect(line(before,'Volume')).toContain('valuemax="100"');
  expect(line(before,'Volume')).toContain('valuetext="40 percent"');
  expect(line(before,'Quantity')).toContain('valuenow="3"');
  expect(line(before,'Invalid')).not.toContain('valuenow=');
  expect(line(before,'Invalid')).not.toContain('valuemin=');
  expect(line(before,'Invalid')).not.toContain('valuemax=');
  expect(before).not.toContain('7391');
  expect(before).not.toContain('private sentinel');
  expect(before).toContain('valuetext="<redacted>"');
  expect(line(before,'Native volume')).toContain('value="30"');
  await page.getByRole('slider',{name:'Volume',exact:true}).press('ArrowRight');
  const after=text(await session.execute('browser_snapshot',{}));
  expect(line(after,'Volume')).toContain('valuenow="50"');
  expect(line(after,'Volume')).toContain('valuetext="50 percent"');
 } finally {await browser.close();await driver.stop();await rm(root,{recursive:true,force:true});}
},30_000);
