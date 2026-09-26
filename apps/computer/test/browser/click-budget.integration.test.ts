import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("blocked clicks yield promptly without forcing or replaying; transient blockers still settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "click-budget-"));
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({headless:true, executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const server = Bun.serve({port:0,fetch:()=>new Response('<!doctype html><button id="target" onclick="window.clicks++">Target</button><div id="cover" style="display:none;position:fixed;inset:0;background:white">Cover</div><script>window.clicks=0</script>',{headers:{"content-type":"text/html"}})});
  try {
    await session.execute("browser_navigate",{url:server.url.href});
    const page = await (session as any).ensurePage();
    const ref = async () => {
      const result = await session.execute("browser_snapshot",{});
      const line = result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n').split('\n').find((l:string)=>l.includes('"Target"') && l.includes('[ref='))!;
      return line.match(/\[ref=([^\]]+)\]/)![1];
    };
    for (const mode of ['hidden','covered']) {
      const target = await ref();
      await page.evaluate((mode: string) => {document.getElementById(mode==='hidden'?'target':'cover')!.style.display=mode==='hidden'?'none':'block';},mode);
      const start = Date.now();
      let failure = '';
      try {await session.execute('browser_click',{ref:target});} catch(error) {failure=String(error);}
      const elapsed=Date.now()-start;
      console.log(JSON.stringify({mode,elapsed,clicks:await page.evaluate(()=>(window as any).clicks)}));
      expect(failure).toContain('Timeout');
      expect(elapsed).toBeLessThan(13_000);
      expect(failure).toContain('fresh browser_snapshot');
      expect(await page.evaluate(()=>(window as any).clicks)).toBe(0);
      await page.evaluate(()=>{document.getElementById('target')!.style.display='block';document.getElementById('cover')!.style.display='none';});
    }
    const target = await ref();
    await page.evaluate(()=>{document.getElementById('cover')!.style.display='block';setTimeout(()=>document.getElementById('cover')!.style.display='none',700);});
    await session.execute('browser_click',{ref:target});
    expect(await page.evaluate(()=>(window as any).clicks)).toBe(1);
    await session.execute('browser_click',{ref:target,doubleClick:true,holdDurationMs:120});
    expect(await page.evaluate(()=>(window as any).clicks)).toBe(3);
  } finally {await browser.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},70_000);
