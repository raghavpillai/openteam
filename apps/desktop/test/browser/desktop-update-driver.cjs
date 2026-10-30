const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 806,
      height: 518,
      webPreferences: { backgroundThrottling: false },
    });
    let passed = 0;
    const errors = [];
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") {
        errors.push(message);
        console.error(message);
      }
    });
    const js = (s) => win.webContents.executeJavaScript(s);
    const assert = async (s, m) => {
      if (!(await js(s))) {
        const geometry = await js(
          `['[role=menu]', '[role=menu] > div', '[role=alertdialog]'].map(selector => ({selector, box:document.querySelector(selector)?.getBoundingClientRect().toJSON()}))`
        );
        throw new Error(`${m}: ${JSON.stringify(geometry)}`);
      }
      passed++;
    };
    const click = async (selector) => {
      const point = await js(
        `(()=>{const el=${selector}; if(!el) throw new Error('Click target missing'); const b=el.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`
      );
      win.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...point,
      });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(250);
      await win.webContents.capturePage();
      await js(
        "Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)))"
      );
    };
    const button = (text) =>
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
    const shot = async (name) => {
      // Let theme changes and the progress transition reach their rendered state.
      await delay(350);
      fs.writeFileSync(
        path.join(process.argv[3], name + ".png"),
        (await win.webContents.capturePage()).toPNG()
      );
    };
    await win.loadURL(process.argv[2]);
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
    await delay(400);
    await assert(
      `document.querySelector('[data-desktop-update-badge="available"]')?.textContent.includes('Update')`,
      "Update badge must appear before opening the account menu"
    );
    await assert(
      `document.getElementById(document.getElementById('account').getAttribute('aria-describedby'))?.textContent.includes('update is available')`,
      "Account trigger must describe the update for screen readers"
    );
    await shot("update-badge-dark");
    await js(`fixture.emit({status:'up-to-date'})`);
    await assert(
      `!document.querySelector('[data-desktop-update-badge]')`,
      "Current installations must not show an update badge"
    );
    await js(`fixture.emit({status:'available'})`);
    await click(`document.getElementById('account')`);
    await assert(
      `(()=>{const text=document.querySelector('[role=menu]').textContent;return !['Support','Help Center','Send Feedback','About'].some(label=>text.includes(label))&&text.includes('Settings');})()`,
      "Account menu must keep Settings and omit Support, Help Center, Send Feedback, and About"
    );
    await assert(
      `document.querySelector('[data-desktop-update-card]')?.textContent.includes('Update available')`,
      "Available update card missing"
    );
    await assert(
      `document.querySelector('[data-desktop-update-card]')?.textContent.includes('OpenTeam 0.47.0')`,
      "Update card must identify the available release"
    );
    await assert(
      `(()=>{const b=${button("Download update")}.getBoundingClientRect();return b.height>=32&&b.width>180;})()`,
      "Download action must have a comfortable full-width target"
    );
    await shot("account-dark");
    await js(`fixture.failDownload=true`);
    await click(button("Download update"));
    await assert(
      `fixture.downloads===1&&document.querySelector('[role=alert]')?.textContent.includes('Could not download')&&!!${button("Download update")}`,
      "Download failure must show an error and allow retry"
    );
    await js(`fixture.failDownload=false`);
    await click(button("Download update"));
    await assert(
      `fixture.downloads===2 && fixture.installs===0`,
      "Download must not restart the app"
    );
    await assert(
      `document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='42'&&!${button("Download update")}`,
      "Progress must be accessible and prevent duplicate downloads"
    );
    await js(`fixture.emit({progress:72})`);
    await assert(
      `document.querySelector('[data-desktop-update-badge]')?.textContent.includes('72%')`,
      "Badge must reflect live download progress"
    );
    await shot("downloading-dark");
    await js(`document.documentElement.dataset.theme='light'`);
    await shot("downloading-light");
    await js(`fixture.emit({progress:null})`);
    await assert(
      `!document.querySelector('[role=progressbar]').hasAttribute('aria-valuenow')&&document.querySelector('[data-desktop-update-card]').textContent.includes('Preparing…')`,
      "Unknown progress must be indeterminate"
    );
    await js(`fixture.emit({progress:140})`);
    await assert(
      `document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='100'&&document.querySelector('[data-desktop-update-badge]').textContent.includes('100%')`,
      "Progress must stay within its bounds"
    );
    await js(`document.documentElement.dataset.theme='dark'`);
    await js(`fixture.emit({status:'downloaded',progress:100})`);
    await delay(300);
    await assert(
      `document.querySelector('[role=alertdialog]')?.textContent.includes('OpenTeam 0.47.0')`,
      "Versioned ready dialog missing"
    );
    await assert(
      `!document.querySelector('[role=menu]')`,
      "Menu must close when ready dialog opens"
    );
    await assert(`fixture.installs===0`, "Ready state must wait for restart confirmation");
    await assert(
      `(()=>{const b=document.querySelector('[role=alertdialog]').getBoundingClientRect();return b.width===380&&b.height===151;})()`,
      "Dialog must match the 380 × 151 reference"
    );
    await assert(
      `(()=>{const a=${button("Not now")}.getBoundingClientRect(),b=${button("Restart to update")}.getBoundingClientRect();return a.width===132&&b.width===211&&a.height===32&&b.height===32&&b.left-a.right===8;})()`,
      "Dialog button dimensions and gap must match the reference"
    );
    await assert(
      `(()=>{const a=document.querySelector('[role=alertdialog]').getBoundingClientRect(),b=${button("Not now")}.getBoundingClientRect(),c=${button("Restart to update")}.getBoundingClientRect();return b.left-a.left===16.5&&a.right-c.right===12.5;})()`,
      "Dialog must preserve the reference insets"
    );
    await shot("update-ready-dark");
    await js(`document.documentElement.dataset.theme='light'`);
    await delay(250);
    await shot("update-ready-light");
    await js(`document.documentElement.dataset.theme='dark'`);
    await assert(
      `document.activeElement.textContent.trim()==='Not now'`,
      "Dialog must initially focus Not now"
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await delay(100);
    await assert(
      `document.activeElement.textContent.trim()==='Restart to update'`,
      "Tab must reach Restart to update"
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await delay(100);
    await assert(
      `document.activeElement.textContent.trim()==='Not now'`,
      "Tab must stay inside the dialog"
    );
    await click(button("Not now"));
    await assert(
      `fixture.installs===0 && !document.querySelector('[role=alertdialog]')`,
      "Not now must dismiss without restart"
    );
    await assert(
      `document.querySelector('[data-desktop-update-badge="downloaded"]')?.textContent.includes('Restart')`,
      "Restart badge must persist after dismissing the ready dialog"
    );
    await js(`fixture.emit({status:'downloaded'})`);
    await delay(100);
    await assert(
      `!document.querySelector('[role=alertdialog]')`,
      "Repeated progress must respect dismissal"
    );
    await click(`document.getElementById('account')`);
    await assert(
      `document.querySelector('[data-desktop-update-card]')?.textContent.includes('Ready to restart')`,
      "Downloaded card must describe the restart action"
    );
    await shot("account-ready-dark");
    await click(button("Restart to update"));
    await assert(
      `!!document.querySelector('[role=alertdialog]')`,
      "Restart action must reopen ready dialog"
    );
    await js(`fixture.failInstall=true`);
    await click(button("Restart to update"));
    await assert(
      `document.querySelector('[role=alert]')?.textContent.includes('Test restart failed')`,
      "Failed restart must be visible"
    );
    await assert(
      `!${button("Restart to update")}.disabled`,
      "Restart can be retried after failure"
    );
    await js(
      `fixture.failInstall=false; ${button("Restart to update")}.click(); ${button("Restart to update")}.click();`
    );
    await delay(100);
    await assert(`fixture.installs===2`, "Restart must only submit once while pending");
    await assert(
      `${button("Restarting…")}.disabled && ${button("Not now")}.disabled`,
      "Restart must disable actions"
    );
    await win.loadURL(process.argv[2] + "?compact");
    await delay(600);
    await assert(
      `(()=>{const badge=document.querySelector('[data-desktop-update-badge]'),account=document.getElementById('account');const b=badge.getBoundingClientRect(),a=account.getBoundingClientRect();return b.width===16&&b.height===16&&b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom;})()`,
      "Collapsed sidebar must keep a visible badge on the account button"
    );
    await shot("update-badge-compact");
    await click(`document.getElementById('account')`);
    await assert(
      `!!${button("Download update")}`,
      "Collapsed sidebar badge must lead to the update action"
    );
    await shot("account-compact");
    await js(`fixture.emit({status:'error'})`);
    await assert(
      `!document.querySelector('[data-desktop-update-badge]')&&!document.querySelector('[data-desktop-update-card]')`,
      "A failed check must not claim an update is available"
    );
    await win.loadURL(process.argv[2] + "?settings");
    await delay(600);
    await js(`fixture.emit({status:'downloaded'})`);
    await delay(250);
    await click(button("Not now"));
    await click(button("Restart to update"));
    await assert(
      `fixture.installs===0 && !!document.querySelector('[role=alertdialog]')`,
      "Settings restart must open confirmation"
    );
    win.setSize(320, 520);
    await delay(200);
    await shot("update-ready-narrow");
    await assert(
      `(()=>{const r=document.querySelector('[role=alertdialog]').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth;})()`,
      "Narrow dialog must stay in viewport"
    );
    await click(button("Not now"));
    await js(`fixture.emit({latestVersion:null,status:'downloaded'})`);
    await delay(200);
    await assert(
      `document.querySelector('[role=alertdialog]')?.textContent.includes('installing OpenTeam. Your Bots')`,
      "Missing version must read naturally"
    );
    if (errors.length) throw new Error(errors.join("\n"));
    fs.writeFileSync(
      path.join(process.argv[3], "results.json"),
      JSON.stringify(
        {
          passed,
          scenarios: [
            "persistent expanded and collapsed sidebar badges",
            "versioned update card and accessible progress",
            "download error and retry",
            "unknown and out-of-range progress",
            "keyboard focus and Tab containment",
            "download progress",
            "versioned ready dialog",
            "no automatic restart",
            "dismissal and reopening",
            "restart error and retry",
            "duplicate restart protection",
            "Settings confirmation",
            "dark/light/narrow rendering",
            "missing version fallback",
          ],
        },
        null,
        2
      )
    );
    console.log(`${passed} update UI checks passed`);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
