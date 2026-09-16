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
    const shot = async (name) =>
      fs.writeFileSync(
        path.join(process.argv[3], name + ".png"),
        (await win.webContents.capturePage()).toPNG()
      );
    await win.loadURL(process.argv[2]);
    for (let i = 0; i < 150 && !(await js("window.fixture?.ready")); i++) await delay(100);
    await delay(400);
    await click(`document.getElementById('account')`);
    await assert(
      `document.body.textContent.includes('New update available')`,
      "Available banner missing"
    );
    await assert(
      `(()=>{const b=document.querySelector('[role=menu] > div').getBoundingClientRect();return b.width===216&&b.height===46;})()`,
      "Banner must match the 216 × 46 reference"
    );
    await assert(
      `(()=>{const b=${button("Install")}.getBoundingClientRect();return b.width===47.5&&b.height===26;})()`,
      "Install button must match the 47.5 × 26 reference"
    );
    await assert(
      `getComputedStyle(document.querySelector('[role=menu] > div')).backgroundColor==='rgb(27, 59, 98)'`,
      "Banner must use the color-managed reference blue"
    );
    await shot("account-dark");
    await click(button("Install"));
    await assert(
      `fixture.downloads===1 && fixture.installs===0`,
      "Install must download without restarting"
    );
    await assert(`${button("42%")}.disabled`, "Progress must disable duplicate download");
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
    await js(`fixture.emit({status:'downloaded'})`);
    await delay(100);
    await assert(
      `!document.querySelector('[role=alertdialog]')`,
      "Repeated progress must respect dismissal"
    );
    await click(`document.getElementById('account')`);
    await click(button("Install"));
    await assert(
      `!!document.querySelector('[role=alertdialog]')`,
      "Install must reopen ready dialog"
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
            "reference geometry and colors",
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
