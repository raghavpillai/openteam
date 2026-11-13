import { _electron } from "../../computer/node_modules/playwright-core";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { encodeScreenPng } from "../src/main/screenbot-png";
const root = resolve(import.meta.dir, "../../.."),
  out = resolve(process.env.SCREENBOT_QA_OUT || "output/desktop-qa/production-screenbot");
await mkdir(out, { recursive: true });
const defaults = {
  search: "CommandOrControl+K",
  toggleSidebar: "CommandOrControl+B",
  settings: "CommandOrControl+,",
  dictate: "CommandOrControl+D",
  previousBot: "CommandOrControl+Up",
  nextBot: "CommandOrControl+Down",
};
const entry = join(out, "electron-main.cjs");
await writeFile(
  entry,
  `const {app,BrowserWindow,ipcMain,session}=require('electron');app.setPath('userData',${JSON.stringify(join(out, "profile"))});global.events=[];global.sendMode='failure';global.pendingSend=null;ipcMain.handle('openteam:shortcuts:get',()=>({bindings:${JSON.stringify(defaults)},defaults:${JSON.stringify(defaults)}}));ipcMain.handle('screenbot:send',async(_e,r)=>{global.events.push({channel:'send',payload:r});if(global.sendMode==='pending')return new Promise(resolve=>{global.pendingSend=resolve});await new Promise(r=>setTimeout(r,200));return global.sendMode==='success'?{ok:true,botName:r.botId}:{ok:false,error:'Synthetic delivery rejected'};});ipcMain.handle('screenbot:transcribe',()=>{throw Error('QA does not record audio')});for(const channel of ['screenbot:ready','screenbot:interactive','screenbot:focus','screenbot:draft','screenbot:closed','screenbot:open-chat'])ipcMain.on(channel,(_e,payload)=>global.events.push({channel,payload}));app.whenReady().then(()=>{session.fromPartition('persist:owned-screenbot-qa').webRequest.onBeforeRequest((d,cb)=>cb({cancel:!['file:','data:','blob:','devtools:'].includes(new URL(d.url).protocol)}));new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{partition:'persist:owned-screenbot-qa',preload:${JSON.stringify(join(root, "apps/desktop/dist-electron/screenbot-preload.cjs"))},contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(root, "apps/desktop/dist/screenbot.html"))});});app.on('window-all-closed',()=>app.quit());`
);
const app = await _electron.launch({
  executablePath: createRequire(join(root, "apps/desktop/package.json"))("electron"),
  args: [entry],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  timeout: 20000,
});
const page = await app.firstWindow();
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks: any[] = [];
const check = (ok: any, label: string, detail?: any) => {
  checks.push({ label, pass: !!ok, detail });
  if (!ok) throw Error(label);
};
const scenario = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (e) {
    checks.push({ scenario: name, pass: false, error: String(e) });
    await page.screenshot({ path: join(out, name + "-failure.png") }).catch(() => {});
  }
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
};
const width = 1280,
  height = 800;
const png = await encodeScreenPng(new Uint8Array(8 * 8 * 4).fill(123), 8, 8, "rgba");
let version = 1;
const bot = (id: string) => ({
  id,
  name: id,
  title: "Owned synthetic Bot",
  color: "blue",
  icon: "chip",
  channelId: "channel-" + id,
});
const roster = {
  accountScope: "scope-A",
  bots: [bot("Account A"), bot("Alternate A")],
  dictation: false,
  theme: "light",
};
const shot = (id: string, draft = "", accountScope = "scope-A", bots = roster.bots) => ({
  id,
  accountScope,
  image: png.toString("base64"),
  width,
  height,
  offsetX: 0,
  offsetY: 0,
  workArea: { x: 0, y: 24, width, height: height - 24 },
  roster: { ...roster, accountScope, bots },
  rosterVersion: version++,
  draft,
});
const publish = async (channel: string, payload: any) =>
  app.evaluate(
    ({ BrowserWindow }, [channel, payload]) => {
      if (channel === "screenbot:shot") payload.image = Buffer.from(payload.image, "base64");
      BrowserWindow.getAllWindows()[0].webContents.send(channel, payload);
    },
    [channel, payload]
  );

const textbox = () => page.locator(".screenbot-input");
const composed = async () => {
  await page.waitForFunction(() => {
    const button = document.querySelector(".screenbot-send") as HTMLButtonElement | null;
    return !!button && !button.disabled;
  });
};
const idle = async () => {
  await page.waitForFunction(
    () => document.querySelector(".screenbot-stage")?.getAttribute("data-phase") === "idle"
  );
  check((await textbox().inputValue()) === "", "reset clears renderer text");
  check((await page.locator('img[alt="Screenshot"]').count()) === 0, "reset releases image nodes");
};
const reset = async () => publish("screenbot:reset", null);
const scopeRoster = (scope: string | null, bots: any[] = []) =>
  publish("screenbot:roster", { accountScope: scope, bots, dictation: false, version: version++ });
await scenario("normal-and-failure", async () => {
  await page.waitForFunction(() => !!window.screenbot);
  check(
    await page.evaluate(() => !window.openteam),
    "production sandbox exposes no account bridge"
  );
  await publish("screenbot:shot", shot("owned-shot-1"));
  await composed();
  await textbox().fill("Synthetic account A private draft");
  await page.getByRole("button", { name: "Send to Account A. Change Bot", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "Alternate A" }).click();
  check(
    (await textbox().inputValue()) === "Synthetic account A private draft",
    "picker preserves draft"
  );
  await page.getByRole("button", { name: "Send to Alternate A", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic delivery rejected" }).waitFor();
  await composed();
  check(
    (await textbox().inputValue()) === "Synthetic account A private draft",
    "same-account failure restores draft"
  );
  const events = await app.evaluate(() => global.events);
  check(
    events.some((e) => e.channel === "screenbot:ready" && e.payload === "owned-shot-1"),
    "ready IPC identifies its shot"
  );
});
await scenario("same-account-empty-roster", async () => {
  await scopeRoster("scope-A");
  await scopeRoster("scope-A", roster.bots);
  await composed();
  check(
    (await textbox().inputValue()) === "Synthetic account A private draft",
    "same-account empty refresh preserves words"
  );
  check(
    (await page.locator('img[alt="Screenshot"]').count()) > 0,
    "same-account refresh preserves screenshot"
  );
});
await scenario("sign-out-and-new-account", async () => {
  await reset();
  await scopeRoster(null);
  await scopeRoster("scope-B", [bot("Account B")]);
  await idle();
  await publish("screenbot:shot", shot("owned-shot-B", "", "scope-B", [bot("Account B")]));
  await composed();
  check((await textbox().inputValue()) === "", "new account shot has no A words");
  await textbox().fill("Owned B draft");
  await page.screenshot({ path: join(out, "replacement-account.png") });
});
await scenario("pending-send-account-replacement", async () => {
  await app.evaluate(() => {
    global.sendMode = "pending";
  });
  await page.getByRole("button", { name: "Send to Account B", exact: true }).click();
  await page.waitForTimeout(100);
  check(await app.evaluate(() => !!global.pendingSend), "inert pending send reached");
  await reset();
  await scopeRoster(null);
  await scopeRoster("scope-C", [bot("Account C")]);
  await publish("screenbot:shot", shot("owned-shot-C", "", "scope-C", [bot("Account C")]));
  await composed();
  await textbox().fill("Current C words");
  await app.evaluate(() => {
    global.pendingSend({ ok: false, error: "Old account failed" });
    global.pendingSend = null;
  });
  await page.waitForTimeout(400);
  check(
    (await textbox().inputValue()) === "Current C words",
    "late old-account failure cannot restore B words"
  );
  check((await page.getByRole("alert").count()) === 0, "late old-account error stays cleared");
});
await scenario("pending-send-same-account-retake", async () => {
  await page.getByRole("button", { name: "Send to Account C", exact: true }).click();
  await page.waitForTimeout(100);
  check(await app.evaluate(() => !!global.pendingSend), "inert pending send reached");
  await publish("screenbot:shot", shot("owned-shot-C-retake", "", "scope-C", [bot("Account C")]));
  await composed();
  await app.evaluate(() => {
    global.pendingSend({ ok: false, error: "Same account retry" });
    global.pendingSend = null;
  });
  await page.getByRole("alert").filter({ hasText: "Same account retry" }).waitFor();
  check(
    (await textbox().inputValue()) === "Current C words",
    "same-account retake restores failed-send words"
  );
});
await scenario("cleanup-while-send-pending", async () => {
  await composed();
  await page.getByRole("button", { name: "Send to Account C", exact: true }).click();
  await page.waitForTimeout(100);
  check(await app.evaluate(() => !!global.pendingSend), "inert pending send reached");
  await reset();
  // A workspace effect cleanup/restart can use the same auth scope: reset is still a fence.
  await publish(
    "screenbot:shot",
    shot("owned-shot-C-after-cleanup", "", "scope-C", [bot("Account C")])
  );
  await composed();
  await textbox().fill("After cleanup");
  await app.evaluate(() => {
    global.pendingSend({ ok: false, error: "Before cleanup failed" });
    global.pendingSend = null;
  });
  await page.waitForTimeout(400);
  check(
    (await textbox().inputValue()) === "After cleanup",
    "cleanup fences same-scope pending restoration"
  );
  check((await page.getByRole("alert").count()) === 0, "cleanup fences pending error");
});
await scenario("close-and-release", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  const events = await app.evaluate(() => global.events);
  check(
    events.some(
      (e) => e.channel === "screenbot:closed" && e.payload === "owned-shot-C-after-cleanup"
    ),
    "close IPC identifies its shot"
  );
  await publish("screenbot:hidden", null);
  await page.waitForFunction(() => document.querySelectorAll('img[alt="Screenshot"]').length === 0);
  check(
    (await page.locator('img[alt="Screenshot"]').count()) === 0,
    "close releases renderer image nodes"
  );
});
await scenario("account-change-during-decode", async () => {
  await page.evaluate(() => {
    const state = window as any;
    state.originalImageDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      return state.originalImageDecode.call(this).then(
        () =>
          new Promise<void>((resolve) => {
            state.resumeImageDecode = resolve;
          })
      );
    };
  });
  await publish(
    "screenbot:shot",
    shot("owned-pending-decode", "Private C pending", "scope-C", [bot("Account C")])
  );
  await page.waitForFunction(() => !!(window as any).resumeImageDecode);
  await reset();
  await scopeRoster("scope-D", [bot("Account D")]);
  await page.evaluate(() => {
    const state = window as any;
    HTMLImageElement.prototype.decode = state.originalImageDecode;
    state.resumeImageDecode();
    state.resumeImageDecode = null;
  });
  await idle();
  const events = await app.evaluate(() => global.events);
  check(
    !events.some(
      (event) => event.channel === "screenbot:ready" && event.payload === "owned-pending-decode"
    ),
    "old decode completion cannot reveal a shot"
  );
  await publish("screenbot:shot", shot("owned-shot-D", "", "scope-D", [bot("Account D")]));
  await composed();
  check((await textbox().inputValue()) === "", "old decoded draft cannot restore into new account");
});
await scenario("account-change-during-failure-restoration", async () => {
  await app.evaluate(() => {
    global.sendMode = "failure";
  });
  await textbox().fill("Private D restoring");
  await page.getByRole("button", { name: "Send to Account D", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".screenbot-stage")?.getAttribute("data-phase") === "intro"
  );
  await reset();
  await scopeRoster("scope-E", [bot("Account E")]);
  await publish("screenbot:shot", shot("owned-shot-E", "", "scope-E", [bot("Account E")]));
  await composed();
  check((await textbox().inputValue()) === "", "reset during failure animation clears prior words");
  check(
    (await page.getByRole("alert").count()) === 0,
    "reset during failure animation clears prior error"
  );
});
await scenario("renderer-reload", async () => {
  await textbox().fill("Owned words before reload");
  await page.reload();
  await page.waitForFunction(() => !!window.screenbot);
  await idle();
  await publish(
    "screenbot:shot",
    shot("owned-shot-after-reload", "Owned current draft", "scope-E", [bot("Account E")])
  );
  await composed();
  check(
    (await textbox().inputValue()) === "Owned current draft",
    "reload accepts only fresh main-owned draft"
  );
  await reset();
  await idle();
});
await writeFile(
  join(out, "results.json"),
  JSON.stringify({ checks, errors, events: await app.evaluate(() => global.events) }, null, 2)
);
await app.close();
console.log(JSON.stringify({ checks, errors }, null, 2));
if (checks.some((c) => !c.pass) || errors.length) process.exitCode = 1;
