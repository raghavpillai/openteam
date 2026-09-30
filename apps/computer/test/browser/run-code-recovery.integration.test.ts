import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("script recovery preserves frames, tab selection, logs and upload handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "script-recovery-"));
  let frameLoads = 0;
  const server = Bun.serve({port: 0, hostname:'127.0.0.1', fetch: request => {
    const url = new URL(request.url);
    if (url.pathname === "/data") return Response.json({_id: "record-7", __typename: "Listing", constructor: "ordinary field", price: 42});
    if (url.pathname === "/nested") return new Response('<input aria-label="Nested entry">',{headers:{"content-type":"text/html"}});
    if (url.pathname === "/frame") {
      frameLoads++;
      return new Response(`<input aria-label="Frame entry"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output><iframe src="http://127.0.0.1:${url.port}/nested"></iframe>`, {headers:{"content-type":"text/html"}});
    }
    if (url.pathname === "/popup") return new Response("<title>Popup</title><h1>Popup works</h1>", {headers:{"content-type":"text/html"}});
    return new Response(`<title>Recovery</title>
      <button id="popup" onclick="window.open('/popup')">Open popup</button>
      <button id="prompt" onclick="document.querySelector('output').textContent=prompt('Observed prompt')">Prompt</button>
      <input type="file" id="upload" onchange="document.querySelector('output').textContent=this.files[0]?.name||'empty'">
      <button id="choose" onclick="document.querySelector('#upload').click()">Choose file</button>
      <output>Ready</output><iframe src="http://localhost:${url.port}/frame"></iframe>`, {headers:{"content-type":"text/html"}});
  }});
  const driver = await outOfProcessPlaywright();
  const profile = join(root,"profile");
  const context = await driver.playwright.chromium.launchPersistentContext(profile, {
    executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, headless:true, args:["--remote-debugging-port=0"],
  });
  context.on("dialog",()=>{});
  try {
    const port = (await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0];
    // Keep multiple independent CDP clients/tabs alive, as concurrent workers do.
    // A single fresh page concealed missing attachment replay in earlier tests.
    for(let index=0;index<4;index++) {
      const sibling=await BrowserUseSession.connect(`http://127.0.0.1:${port}`,root,false,root);
      await sibling.execute("browser_navigate",{url:`http://127.0.0.1:${server.port}/?sibling=${index}`});
    }
    const session = await BrowserUseSession.connect(`http://127.0.0.1:${port}`,root,false,root);
    session.configureUploads(root);
    const url = `http://127.0.0.1:${server.port}`;
    const run = async (code:string) => { const result=JSON.parse((await session.execute("browser_run_code",{code})).content.filter(p=>p.type==="text").map(p=>(p as any).text).join("")); if(result.error) console.info("Script diagnostic",result.error); return result; };
    await session.execute("browser_navigate",{url});
    const loaded = frameLoads;
    // Every run attaches a fresh client to the already-loaded iframe. Neither
    // repairing the attachment nor subsequent runs may reload the form.
    expect((await run(`async(page)=>{await page.frameLocator('iframe').getByLabel('Frame entry').fill('preserved',{timeout:3000});return 'filled'}`)).result).toBe("filled");
    expect((await run(`async(page)=>{const f=page.frameLocator('iframe');await f.getByRole('button',{name:'Apply'}).click({timeout:3000});return f.locator('output').innerText()}`)).result).toBe("preserved");
    expect((await run(`async(page)=>{const f=page.frameLocator('iframe').frameLocator('iframe');await f.getByLabel('Nested entry').fill('nested preserved',{timeout:3000});return f.getByLabel('Nested entry').inputValue()}`)).result).toBe("nested preserved");
    expect((await run(`async(page)=>page.frameLocator('iframe').frameLocator('iframe').getByLabel('Nested entry').inputValue({timeout:3000})`)).result).toBe("nested preserved");
    expect(frameLoads).toBe(loaded);
    const expected = {_id:"record-7",__typename:"Listing",constructor:"ordinary field",price:42};
    expect((await run(`async(page)=>await(await page.request.get('${url}/data')).json()`)).result).toEqual(expected);
    expect((await run(`async(page)=>page.evaluate(()=>({_id:'record-7',__typename:'Listing',constructor:'ordinary field',price:42}))`)).result).toEqual(expected);
    const assertion = await run(`async(page)=>{console.assert(false,'synthetic assertion');return 'continued'}`);
    expect(assertion.result).toBe("continued");
    expect(assertion.stdio).toContainEqual({type:"error",text:"Assertion failed: synthetic assertion"});
    const failure = await run(`async(page)=>{console.log('before failure');throw new Error('expected failure')}`);
    expect(failure.error).toEqual({code:"job_failed",message:"expected failure"});
    expect(failure.stdio).toEqual([{type:"log",text:"before failure"}]);
    const popup = await run(`async(page)=>{const pending=page.waitForEvent('popup');await page.locator('#popup').click();const popup=await pending;await popup.waitForLoadState();return popup.locator('h1').innerText()}`);
    expect(popup.result).toBe("Popup works");
    expect(popup.stdio.some((entry:any)=>entry.text.includes("popup"))).toBe(true);
    expect((await run(`async(page)=>page.title()`)).result).toBe("Popup");
    expect((await session.execute("browser_snapshot",{})).details?.title).toBe("Popup");
    expect((await run(`async(page)=>{const parent=await page.opener();await page.close();await parent.locator('#choose').hover({timeout:2000});return parent.title()}`)).result).toBe("Recovery");
    expect((await run(`async(page)=>{const other=await page.context().newPage();await other.bringToFront();await other.close();await page.locator('#choose').hover({timeout:2000});return 'recovered'}`)).result).toBe("recovered");
    // A logging listener observes a prompt but does not consume it. The normal
    // dialog tool must be able to complete the suspended script exactly once.
    const pending = await session.execute("browser_run_code",{code:`async(page)=>{page.on('dialog',d=>console.log(d.type()));await page.locator('#prompt').click();return page.locator('output').innerText()}`});
    expect(pending.details?.pendingDialog).toBeDefined();
    const answered = await session.execute("browser_handle_dialog",{accept:true,promptText:"external answer"});
    expect(JSON.parse((answered.content[0] as any).text).result).toBe("external answer");
    expect((await run(`async(page)=>{const chooser=page.waitForEvent('filechooser');await page.locator('#choose').click();await chooser;return 'opened'}`)).result).toBe("opened");
    const file = join(root,"sample.txt");await writeFile(file,"synthetic upload fixture");
    const upload = await session.execute("browser_file_upload",{paths:[file]});
    expect(JSON.stringify(upload)).toContain("Uploaded 1 file(s)");
    expect((await run(`async(page)=>page.locator('output').innerText()`)).result).toBe("sample.txt");
    // Script access must still direct uploads through the reviewed tool.
    const denied = await run(`async(page)=>page.locator('#upload').setInputFiles('${file}')`);
    expect(denied.error.message).toContain("browser_file_upload");
  } finally {
    await context.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});
  }
},60_000);
