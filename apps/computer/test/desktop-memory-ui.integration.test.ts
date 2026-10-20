import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ScreenBroker } from "../src/screen-broker";
import { outOfProcessPlaywright } from "../src/browser/playwright-driver";
import { desktopMemoryForSpawn } from "../src/desktop-memory";
import { spawnAgentProcess } from "../src/agent-process";
import { once } from "node:events";
import type { Browser } from "playwright-core";

test.skipIf(process.env.OPENTEAM_TEST_DESKTOP_MEMORY !== "1")("two capped headed desktops preserve UI and tabs while one hits its memory limit", async () => {
  const home = await mkdtemp("/tmp/memory-ui-");
  const broker = new ScreenBroker(home);
  const ids = ["memory-ui-a", "memory-ui-b"];
  const browsers: Browser[] = [];
  const driver = await outOfProcessPlaywright();
  const before = process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT;
  try {
    const statuses = await Promise.all(ids.map(id => broker.ensure(id, "/workspace")));
    expect(statuses.every(s => s.state === "ready")).toBe(true);
    expect(statuses[0]!.display).not.toBe(statuses[1]!.display);
    const pages = [];
    const targetIds: string[][] = [];
    const endpoints: string[] = [];
    for (const id of ids) {
      const group = desktopMemoryForSpawn(id)!;
      expect((await readFile(`${group}/memory.max`, "utf8")).trim()).toBe("10737418240");
      const endpoint = await broker.browserEndpointForAgent(id, "/workspace");
      endpoints.push(endpoint);
      const browser = await driver.playwright.chromium.connectOverCDP(endpoint);
      browsers.push(browser);
      const context = browser.contexts()[0]!;
      const page = context.pages()[0]!;
      await context.newPage();
      await page.setContent('<html><body style="background:#e5eef7"><h1>Memory isolation test</h1><textarea id="field" style="width:600px;height:250px;font:24px sans-serif"></textarea></body></html>');
      await page.bringToFront();
      await page.locator('#field').focus();
      pages.push(page);
      targetIds.push((await (await fetch(`${endpoint}/json/list`)).json() as {type:string;id:string}[]).filter(x=>x.type==='page').map(x=>x.id).sort());
      const session = (broker as any).sessions.get(id);
      for (const child of session.processes) {
        if (child.exitCode === null && child.signalCode === null) {
          expect(await readFile(`/proc/${child.pid}/cgroup`, "utf8")).toContain(group.split('/').at(-1)!);
        }
      }
      const env = await broker.commandEnvironment(id, "/workspace");
      const membership = spawnAgentProcess("/bin/sh", ["-c", "cat /proc/self/cgroup; sleep 0.1 & wait"], {env, stdio:["ignore","pipe","pipe"]});
      const chunks: Buffer[]=[]; membership.stdout.on('data',b=>chunks.push(b));
      expect((await once(membership,'close'))[0]).toBe(0);
      expect(Buffer.concat(chunks).toString()).toContain(group.split('/').at(-1)!);
    }
    await Promise.all(ids.map((id,i)=>broker.act(id, '/workspace', {action:'type',text:`Desktop ${i}: café 東京`}, 'human')));
    for (let i=0;i<2;i++) expect(await pages[i]!.locator('#field').inputValue()).toBe(`Desktop ${i}: café 東京`);
    // Test only: choose the allocator itself for OOM, so existing user-visible
    // fixture tabs remain intact. Production does not change OOM priorities.
    const env = await broker.commandEnvironment(ids[0]!, '/workspace');
    process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT='512m';
    const allocator=spawnAgentProcess('/usr/bin/python3',['-c','open("/proc/self/oom_score_adj","w").write("1000")\na=[]\nwhile True: a.append(bytearray(16*1024*1024))'],{env,stdio:'ignore'});
    const [,signal]=await once(allocator,'close');
    expect(signal).toBe('SIGKILL');
    const group=desktopMemoryForSpawn(ids[0]!)!;
    expect(Number((await readFile(`${group}/memory.events`,'utf8')).match(/^oom_kill (\d+)/m)![1])).toBeGreaterThan(0);
    process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT=before;
    await broker.act(ids[1]!, '/workspace', {action:'type',text:' still alive'},'human');
    expect(await pages[1]!.locator('#field').inputValue()).toBe('Desktop 1: café 東京 still alive');
    for(let i=0;i<2;i++) {
      const targets=(await (await fetch(`${endpoints[i]}/json/list`)).json() as {type:string;id:string}[]).filter(x=>x.type==='page').map(x=>x.id).sort();
      expect(targets).toEqual(targetIds[i]!);
      const png=await broker.screenshot(ids[i]!, '/workspace');
      expect(png.subarray(1,4).toString()).toBe('PNG');
      if(process.env.OPENTEAM_MEMORY_TEST_ARTIFACTS) await writeFile(`${process.env.OPENTEAM_MEMORY_TEST_ARTIFACTS}/desktop-${i}.png`,png);
    }
    console.info('Two headed desktops: separate limits, native Unicode input, isolated OOM, all four tab IDs preserved');
  } finally {
    process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT=before;
    for(const browser of browsers) await browser.close();
    await Promise.all(ids.map(id=>broker.destroy(id)));
    await driver.stop();
    await rm(home,{recursive:true,force:true});
  }
}, 60_000);
