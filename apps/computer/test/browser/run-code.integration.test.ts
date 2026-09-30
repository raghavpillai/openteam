import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession, BROWSER_USE_TOOLS } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { runBrowserCode } from "../../src/browser/run-code";

test("run-code contract uses Grok's code-only schema and is exposed to browser workers", () => {
 const tool = BROWSER_USE_TOOLS.find(t => t.name === "browser_run_code")!;
 expect(tool).toBeDefined();
 expect(tool.inputSchema.required).toEqual(["code"]);
 expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["code"]);
 expect((tool.inputSchema.properties as any).code.maxLength).toBe(16384);
});

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("batched Playwright scripts, fresh globals, tab selection, failures and limits on real Chromium", async () => {
 const root = await mkdtemp(join(tmpdir(), "run-code-"));
 const server = Bun.serve({port:0,fetch:()=>new Response(`<!doctype html><title>Script test</title>
 <input aria-label="Name"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><output></output>
 <div class="row"><span>Alpha</span></div><div class="row"><span>Beta</span></div>
 <div id="shadow"></div><iframe srcdoc="<button>Frame button</button>"></iframe>
 <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';</script>`, {headers:{"content-type":"text/html"}})});
 const driver = await outOfProcessPlaywright();
 const profile = join(root,"profile");
 const context = await driver.playwright.chromium.launchPersistentContext(profile, {
  executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, headless:true, args:["--remote-debugging-port=0"],
 });
 context.on("dialog",()=>{});
 try {
  const port = (await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0];
  const endpoint = `http://127.0.0.1:${port}`;
  const session = await BrowserUseSession.connect(endpoint,root,false,root);
  const run = async (code:string) => JSON.parse((await session.execute("browser_run_code",{code})).content.filter(p=>p.type==="text").map(p=>(p as any).text).join(""));
  const result = await run(`async (page) => {
   await page.goto('http://127.0.0.1:${server.port}');
   await page.getByLabel('Name').fill('Unicode café 東京');
   await page.getByRole('button',{name:'Save',exact:true}).click();
   console.log('saved'); globalThis.probe=17;
   return {value:await page.locator('output').innerText(),shadow:await page.getByRole('button',{name:'Shadow button'}).count(),frame:await page.frameLocator('iframe').getByRole('button').innerText(),tabs:page.context().pages().length};
  }`);
  expect(result.result).toEqual({value:"Unicode café 東京",shadow:1,frame:"Frame button",tabs:1});
  expect(result.stdio).toEqual([{type:"log",text:"saved"}]);
  expect((await run(`async (page) => ({fresh:typeof probe,require:typeof require,process:typeof process,url:page.url(),encoding:Buffer.from('hi').toString('base64'),host:new URL(page.url()).hostname})`)).result).toEqual({fresh:"undefined",require:"undefined",process:"undefined",url:`http://127.0.0.1:${server.port}/`,encoding:"aGk=",host:"127.0.0.1"});
  await run(`async (page) => {const next=await page.context().newPage();await next.goto('data:text/html,<title>Second tab</title><h1>Selected second</h1>');await next.bringToFront();return next.url();}`);
  expect((await run(`async (page) => ({title:await page.title(),tabs:page.context().pages().length})`)).result).toEqual({title:"Second tab",tabs:2});
  const snap=await session.execute("browser_snapshot",{});
  expect(JSON.stringify(snap)).toContain("Selected second");
  await run(`async (page) => {const first=page.context().pages().find(p=>p.url().startsWith('http:'));await first.bringToFront();return await first.title();}`);
  expect((await run(`async (page)=>await page.title()`)).result).toBe("Script test");
  expect((await run(`async(page)=>'x'.repeat(40000)`)).result.length).toBe(40000);
  expect((await run(`async(page)=>{const next=page.context().pages().find(p=>p.url().startsWith('data:'));await next.bringToFront();throw new Error('after switching')}`)).error.message).toContain('after switching');
  expect((await run(`async(page)=>await page.title()`)).result).toBe('Second tab');
  const background=await run(`async(page)=>{
   const first=page.context().pages().find(p=>p.url().startsWith('http:'));
   await first.getByLabel('Name').fill('Background fill');
   const click=first.getByRole('button',{name:'Save',exact:true}).click();
   await first.bringToFront();await click;
   return await first.locator('output').innerText();
  }`);
  expect(background.result).toBe('Background fill');
  for (const code of ["not valid !", "async(page)=>{throw new Error('intentional failure')}","async(page)=>{const x={};x.self=x;return x}","async(page)=>'x'.repeat(262145)","async(page)=>page.context().cookies()", "async(page)=>page.getByLabel('Name').setInputFiles('/tmp/no')"])
   expect((await run(code)).error.message).toBeTruthy();
  expect((await run(`async (page)=>await page.title()`)).result).toBe("Script test");
  const page = await (session as any).ensurePage();
  const target = (session as any).targetIds.get((session as any).idFor(page));
  const input={endpoint,targets:[target],selected:target,code:"async(page)=>{while(true){}}"};
  await expect(runBrowserCode(input,undefined,1200)).rejects.toThrow("limit");
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),1200);
  try { await expect(runBrowserCode({...input,code:"async(page)=>await new Promise(()=>{})"},controller.signal)).rejects.toThrow("cancelled"); }
  finally {clearTimeout(timer);}
  expect((await run(`async(page)=>await page.title()`)).result).toBe("Script test");
  // Nested Playwright objects must reach Playwright itself, not its proxy guard.
  expect((await run(`async(page)=>await page.locator('.row').filter({has:page.getByText('Beta',{exact:true})}).count()`)).result).toBe(1);
  expect((await run(`async(page)=>{const el=await page.locator('.row').first().elementHandle();return page.evaluate(({nested})=>nested[0].textContent,{nested:[el]})}`)).result).toBe('Alpha');
  const ownedDialog=await run(`async(page)=>{page.once('dialog',d=>d.accept('accepted'));return await page.evaluate(()=>prompt('Script-owned prompt'))}`);
  expect(ownedDialog.result).toBe('accepted');
  const pending=await session.execute('browser_run_code',{code:`async(page)=>await page.evaluate(()=>prompt('Externally handled prompt'))`});
  expect(pending.details?.pendingDialog).toBeDefined();
  const accepted=await session.execute('browser_handle_dialog',{accept:true,promptText:'external'});
  expect(JSON.parse((accepted.content[0] as any).text).result).toBe('external');
  const backgroundPrompt=await session.execute('browser_run_code',{code:`async(page)=>{const other=await page.context().newPage();return other.evaluate(()=>prompt('Background prompt'))}`});
  expect(backgroundPrompt.details?.pendingDialog).toBeDefined();
  const backgroundAccepted=await session.execute('browser_handle_dialog',{accept:false});
  expect(JSON.parse((backgroundAccepted.content[0] as any).text).result).toBeNull();
  await session.execute('browser_navigate',{url:`http://127.0.0.1:${server.port}/first`});
  await session.execute('browser_navigate',{url:`http://127.0.0.1:${server.port}/second`});
  const back=await session.execute('browser_navigate_back',{});
  expect(back.details?.url).toBe(`http://127.0.0.1:${server.port}/first`);
  const cancel=new AbortController();
  // Cancel after the selection update is observed, not after a machine-speed
  // dependent sleep that can interrupt Linux before it even creates the tab.
  const cancelWatch=setInterval(()=>{
   const internal=session as any;
   const selected=internal.context.pages().find((p:any)=>internal.ids.get(p)===internal.currentViewId);
   if(selected?.url().includes('Interrupted'))cancel.abort();
  },20);
  const cancelTimer=setTimeout(()=>cancel.abort(),10000);
  try {await expect(session.execute('browser_run_code',{code:`async(page)=>{const next=await page.context().newPage();await next.goto('data:text/html,<title>Interrupted tab</title>');await next.bringToFront();await new Promise(()=>{})}`},cancel.signal)).rejects.toThrow('cancelled');}
  finally {clearTimeout(cancelTimer);clearInterval(cancelWatch);}
  expect((await session.execute('browser_snapshot',{})).details?.title).toBe('Interrupted tab');
  session.registerPrivateValues(["protected-fixture"]);
  await expect(run(`async(page)=>await page.title()`)).rejects.toThrow("protected login");
  await expect(runBrowserCode({...input,code:"x".repeat(16385)})).rejects.toThrow("16384");
 } finally {await context.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},60_000);
