const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.UPDATE_UI_DIR;
const url = process.env.UPDATE_UI_URL;
app.setPath("userData", path.join(directory, "profile"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, width: 806, height: 518, webPreferences: { backgroundThrottling: false } });
    const reports = [];
    const errors = [];
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") errors.push(message);
    });
    const js = (s) => win.webContents.executeJavaScript(s);
    const assert = async (s, m) => {
      if (!(await js(s))) throw new Error(m);
      reports.push(m);
    };
    const click = async (selector) => {
      const point = await js(
        `(()=>{const el=${selector}; if(!el) throw new Error('Click target missing'); const b=el.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`
      );
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(250);
      // The window is hidden; request a frame before waiting for exit animations.
      await win.webContents.capturePage();
      await js(
        "Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)))"
      );
    };
    const button = (text) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
    const load = async (query = "") => {
      await win.loadURL(url + query);
      for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
      await delay(400);
    };

    await load();
    await assert(`document.querySelector('[data-desktop-update-badge="available"]')?.textContent.includes('Update')`, "update badge shows before opening the account menu");
    await js(`fixture.emit({status:'up-to-date'})`);
    await assert(`!document.querySelector('[data-desktop-update-badge]')`, "current installations show no badge");
    await js(`fixture.emit({status:'available'})`);
    await click(`document.getElementById('account')`);
    await assert(`document.querySelector('[data-desktop-update-card]')?.textContent.includes('OpenTeam 0.47.0')`, "account menu card names the available release");
    await js(`fixture.failDownload=true`);
    await click(button("Download update"));
    await assert(`fixture.downloads===1&&document.querySelector('[role=alert]')?.textContent.includes('Could not download')&&!!${button("Download update")}`, "download failure shows an error and allows retry");
    await js(`fixture.failDownload=false`);
    await click(button("Download update"));
    await assert(`fixture.downloads===2 && fixture.installs===0`, "download does not restart the app");
    await assert(`document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='42'&&!${button("Download update")}`, "progress replaces the download action");
    await js(`fixture.emit({progress:140})`);
    await assert(`document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='100'`, "progress stays within bounds");
    await js(`fixture.emit({status:'downloaded',progress:100})`);
    await delay(300);
    await assert(`document.querySelector('[role=alertdialog]')?.textContent.includes('OpenTeam 0.47.0') && !document.querySelector('[role=menu]') && fixture.installs===0`, "ready dialog waits for restart confirmation");
    await click(button("Not now"));
    await assert(`fixture.installs===0 && !document.querySelector('[role=alertdialog]') && document.querySelector('[data-desktop-update-badge="downloaded"]')`, "Not now dismisses without restart and keeps the badge");
    await js(`fixture.emit({status:'downloaded'})`);
    await delay(100);
    await assert(`!document.querySelector('[role=alertdialog]')`, "repeated progress respects dismissal");
    await click(`document.getElementById('account')`);
    await click(button("Restart to update"));
    await assert(`!!document.querySelector('[role=alertdialog]')`, "account restart action reopens the dialog");
    await js(`fixture.failInstall=true`);
    await click(button("Restart to update"));
    await assert(`document.querySelector('[role=alert]')?.textContent.includes('Test restart failed') && !${button("Restart to update")}.disabled`, "failed restart is visible and retryable");
    await js(`fixture.failInstall=false; ${button("Restart to update")}.click(); ${button("Restart to update")}.click();`);
    await delay(100);
    await assert(`fixture.installs===2 && ${button("Restarting…")}.disabled`, "restart submits once while pending");

    await load("?compact");
    await click(`document.getElementById('account')`);
    await assert(`!!document.querySelector('[data-desktop-update-badge]') && !!${button("Download update")}`, "collapsed sidebar badge leads to the update action");
    await js(`fixture.emit({status:'error'})`);
    await assert(`!document.querySelector('[data-desktop-update-badge]')&&!document.querySelector('[data-desktop-update-card]')`, "a failed check does not claim an update");

    await load("?settings");
    await js(`fixture.emit({status:'error',failureKind:'feed-http-status',message:'HttpError: 504 '+'detail '.repeat(1000)+String.fromCharCode(10)+'XML: private release feed'})`);
    await assert(`(()=>{const e=document.querySelector('[data-settings-anchor~="update-status"] .line-clamp-2');return e.textContent.length<=180&&!e.textContent.includes('XML:');})()`, "long update errors are truncated without feed internals");
    await js(`fixture.emit({status:'downloaded',message:null,failureKind:null})`);
    await delay(250);
    await click(button("Not now"));
    await click(button("Restart to update"));
    await assert(`fixture.installs===0 && !!document.querySelector('[role=alertdialog]')`, "Settings restart opens confirmation");
    if (errors.length) throw new Error(errors.join("\n"));
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ reports }));
    app.quit();
  })
  .catch((error) => {
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ error: String(error?.message ?? error), stack: error?.stack }));
    app.exit(1);
  });
