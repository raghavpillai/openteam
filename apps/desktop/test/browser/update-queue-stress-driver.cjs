const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on("render-process-gone", (_event, detail) => errors.push(detail.reason));
  const wait = async (code, message) => { for (let index = 0; index < 400; index++) { if (await js(code)) return; await delay(10); } throw new Error(message + ": " + await js("document.body.innerText")); };
  const click = async text => js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Missing enabled button: '+${JSON.stringify(text)});b.click()})()`);
  const cycles = 30;
  const burst = 500;
  const rounds = [];
  const started = performance.now();
  for (let cycle = 0; cycle < cycles; cycle++) {
    await win.loadURL(process.argv[2] + "?manual&stress");
    await wait("window.updateDemo?.ready && document.querySelector('[data-update-state]')?.dataset.updateState==='ready'", "ready after full renderer reload");
    await click("Update both…");
    await wait("document.querySelector('[role=alertdialog]')?.textContent.includes('No bots are working')", "read-only review");
    const eventMs = await js(`(()=>{const b=[...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent.trim()==='Update both');const start=performance.now();for(let i=0;i<${burst};i++)b.click();return performance.now()-start})()`);
    await wait("updateDemo.posts.length===1", "one server request after event burst");
    if (!await js("updateDemo.downloads===0 && updateDemo.installs===0")) throw new Error("Desktop advanced early");
    await js("updateDemo.server({currentVersion:'0.0.19',status:'updated',phase:'complete'})");
    await wait("updateDemo.downloads===1", "one native download");
    await js("updateDemo.emit({status:'downloaded',progress:100})");
    await wait("document.querySelector('[data-update-queue]')?.dataset.updateQueue==='complete'", "queue completed");
    if (!await js("updateDemo.posts.length===1 && updateDemo.downloads===1 && updateDemo.installs===0")) throw new Error("Duplicate operation or automatic install");
    await click("Not now");
    rounds.push({ cycle, clickAttempts: burst, eventBurstMs: Math.round(eventMs * 100) / 100 });
  }
  if (errors.length) throw new Error(errors.join(", "));
  const result = { cycles, clickAttempts: cycles * burst, wallTimeMs: Math.round(performance.now() - started), simulatedHostUpdates: cycles, simulatedNativeDownloads: cycles, installs: 0, rendererCrashes: errors, observationIntervalMs: 10, rounds };
  fs.writeFileSync(path.join(process.argv[3], "results.json"), JSON.stringify(result, null, 2));
  console.log(`${result.clickAttempts} rendered click attempts and ${cycles} full renderer reloads passed`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
