import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
const executablePath = process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE;
if (!executablePath) throw Error("Set OPENTEAM_BROWSER_TEST_EXECUTABLE");
const root = await mkdtemp(join(tmpdir(), "browser-frame-detach-"));
await chmod(root, 0o755);
const driver = await outOfProcessPlaywright();
let context: any, session: BrowserUseSession | undefined;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<!doctype html><title>Frame detachment fixture</title><button>Small control</button>', { headers: { "content-type": "text/html" } }) });
try {
  const profile = join(root, "profile");
  context = await driver.playwright.chromium.launchPersistentContext(profile, { headless: true, executablePath, args: ["--remote-debugging-port=0"] });
  const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
  session = await BrowserUseSession.connect(`http://127.0.0.1:${port}`, join(root, "artifacts"), false);
  const small = await session.execute("browser_navigate", { url: server.url.href });
  assert.ok(JSON.stringify(small.content).includes("Small control"));
  const page = await (session as any).ensurePage();
  await page.evaluate(() => { const f=document.createElement('iframe');f.srcdoc='<p data-openteam-private="true">fixture private</p>';document.body.append(f); });
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('p'));
  await page.evaluate(()=>{ const p=document.createElement('p');p.dataset.openteamPrivate='true';p.textContent='private fixture';document.body.append(p); });
  const original=page.screenshot.bind(page);let attempts=0;
  page.screenshot=async (options:any)=> { attempts++; assert.equal(await options.mask[0].count(),1,'private main-frame content remains masked on every attempt'); if(attempts===1) await page.locator('iframe').evaluate((n:any)=>n.remove()); return original(options); };
  await session.execute('browser_take_screenshot',{});
  assert.equal(attempts,2,'one retry after real frame detachment');
  page.screenshot=async()=>{attempts++;throw Error('screenshot: Frame was detached');};
  attempts=0;
  await assert.rejects(()=>session!.execute('browser_take_screenshot',{}),/Frame was detached/);
  assert.equal(attempts,2,'persistent detachment does not loop');
  console.log('PASS frame-detach recovery and bounded retry');

} finally {
  await (session as any)?.browser.close().catch(() => {}); await context?.close(); await driver.stop(); server.stop(true); await rm(root,{recursive:true,force:true});
}
