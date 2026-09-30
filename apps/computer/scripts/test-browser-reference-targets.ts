import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../src/browser/use";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
const root = await mkdtemp(join(tmpdir(), "reference-targets-"));
const driver = await outOfProcessPlaywright();
let context: any, session: BrowserUseSession | undefined;
const text = (r: any) => r.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
try {
  context = await driver.playwright.chromium.launchPersistentContext(root, {headless:true, executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args:["--remote-debugging-port=0", ...(process.platform === "linux" ? ["--no-sandbox"] : [])]});
  const port = (await readFile(join(root,"DevToolsActivePort"),"utf8")).split("\n")[0];
  session = await BrowserUseSession.connect(`http://127.0.0.1:${port}`,join(root,"artifacts"),false,join(root,"downloads"));
  const page = await (session as any).ensurePage();
  await page.setContent(`<label id="editable">Original label</label><div id="custom">Custom target</div><span id="hidden" style="display:none">Hidden</span><button id="disabled" disabled>Disabled</button><script>document.querySelector('#editable').addEventListener('dblclick',e=>e.target.textContent='Edited'); document.querySelector('#custom').addEventListener('click',e=>e.target.textContent='Activated');</script>`);
  const selected = async (selector: string) => text(await session!.execute("browser_snapshot",{selector}));
  const label = await selected("#editable");
  assert.match(label,/label "Original label" \[ref=/,"explicitly selected visible static target must have a ref");
  await session.execute("browser_click",{ref:label.match(/\[ref=([^\]]+)\]/)![1],doubleClick:true});
  assert.equal(await page.locator('#editable').textContent(),"Edited");
  const custom=await selected("#custom");
  await session.execute("browser_click",{ref:custom.match(/\[ref=([^\]]+)\]/)![1]});
  assert.equal(await page.locator('#custom').textContent(),"Activated");
  assert.ok(!(await selected("#hidden")).includes("[ref="));
  assert.ok(!(await selected("#disabled")).includes("[ref="));
  console.log("PASS selected label double-click, custom target, hidden/disabled exclusion");
} finally { await (session as any)?.browser.close().catch(() => {}); await context?.close(); await driver.stop(); await rm(root,{recursive:true,force:true}); }
