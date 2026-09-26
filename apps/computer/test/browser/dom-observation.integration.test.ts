import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("DOM observations supply actionable refs, preserve private text masking, and allow explicit images", async () => {
  const root = await mkdtemp(join(tmpdir(), "dom-observation-"));
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response('<!doctype html><label>Name <input aria-label="Name"></label><input type="password" value="hidden-password"><button onclick="this.textContent=\'Saved\'">Save</button>',{headers:{"content-type":"text/html"}})});
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({headless:true, executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const text = (result:any) => result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
  const ref = (result:any,label:string) => text(result).split('\n').find((l:string)=>l.includes(`"${label}"`) && l.includes('[ref='))!.match(/\[ref=([^\]]+)\]/)![1];
  const samples: Record<string,number[]> = {image:[],dom:[]};
  try {
    // Alternate order to avoid attributing browser warmup to either mode.
    for (let round=0;round<6;round++) for (const mode of (round%2 ? ['dom','image'] : ['image','dom']) as ('image'|'dom')[]) {
      session.configureObservationMode(mode);
      const start = performance.now();
      const result = await session.execute('browser_navigate',{url:server.url.href});
      const state = mode === 'image' ? await session.execute('browser_snapshot',{}) : result;
      const clicked = await session.execute('browser_click',{ref:ref(state,'Save')});
      const final = mode === 'image' ? await session.execute('browser_snapshot',{}) : clicked;
      samples[mode]!.push(Math.round(performance.now()-start));
      expect(text(final)).toContain('"Saved"');
      expect(text(final)).not.toContain('hidden-password');
      expect(result.content.some(c=>c.type==='image')).toBe(mode==='image');
      if(mode==='dom') expect(final.content.some(c=>c.type==='image')).toBe(false);
    }
    session.configureObservationMode('dom');
    const snap = await session.execute('browser_snapshot',{});
    expect(text(snap)).toContain('"Saved"');
    const image = await session.execute('browser_take_screenshot',{});
    expect(image.content.some(c=>c.type==='image')).toBe(true);
    expect(image.details?.path).toBeTruthy();
    const view = text(snap).match(/Tab viewId: (view-\d+)/)![1]!;
    const highlighted = await session.execute('browser_highlight',{ref:ref(snap,'Saved'),durationMs:2000});
    expect(highlighted.content.some(c=>c.type==='image')).toBe(true);
    const tabs = await session.execute('browser_tabs',{action:'list'});
    expect(text(tabs)).toContain(`"viewId": "${view}"`);
    await session.execute('browser_tabs',{action:'new'});
    const targeted = await session.execute('browser_take_screenshot',{viewId:view});
    expect(targeted.details?.url).toBe(server.url.href);
    expect(targeted.content.some(c=>c.type==='image')).toBe(true);
    console.log('DOM_OBSERVATION_BENCHMARK',JSON.stringify(samples));
  } finally {await browser.close();await driver.stop();server.stop(true);await rm(root,{recursive:true,force:true});}
},90_000);
