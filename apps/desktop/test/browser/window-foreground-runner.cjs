const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.FOREGROUND_PARITY_DIR;
const arm = process.env.FOREGROUND_PARITY_ARM;
const output = process.env.FOREGROUND_PARITY_OUTPUT;
app.setPath("userData", path.join(directory, arm));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.on("window-all-closed", () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
app.whenReady().then(async () => {
  ipcMain.handle("openteam:window-visibility", () => true);
  ipcMain.handle("openteam:window-activity", () => true);
  const reports = [];
  const rendererErrors = [];
  try {
    for (const theme of ["light", "dark"]) for (const width of [600, 900]) {
      const win = new BrowserWindow({ show: false, width, height: 800, useContentSize: true,
        webPreferences: { backgroundThrottling: false, preload: path.join(directory, `${arm}-preload.cjs`) } });
      win.webContents.on("console-message", event => { if (event.level === "error") { rendererErrors.push(event.message); console.error(event.message); } });
      const evaluate = expression => win.webContents.executeJavaScript(expression);
      await win.loadURL(`${process.env.FOREGROUND_PARITY_URL}?theme=${theme}`);
      for (const scenario of ["chat-idle", "chat-active", "voice-recording", "voice-processing"]) {
        for (let attempt = 0; attempt < 100 && !await evaluate("!!window.foregroundFixture"); attempt++) await pause(50);
        await evaluate(`window.foregroundFixture.render(${JSON.stringify(scenario)})`);
        for (let attempt = 0; attempt < 100 && !await evaluate(`window.foregroundFixture.ready() === ${JSON.stringify(scenario)}`); attempt++) await pause(50);
        assert(await evaluate(`window.foregroundFixture.ready() === ${JSON.stringify(scenario)}`), `${arm}/${scenario}: transcript layout never became ready`);
        await pause(250);
        await evaluate("window.foregroundFixture.settle()");
        await pause(100);
        const state = await evaluate("window.foregroundFixture.state()");
        assert(state.nodes > 80 && !state.inactive, `${arm}/${scenario}: foreground fixture did not render normally`);
        const name = `${theme}-${width}-${scenario}`;
        fs.writeFileSync(path.join(output, `${arm}-${name}.png`), (await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(output, `${arm}-${name}.json`), JSON.stringify(state));
        if (scenario === "chat-idle") {
          await evaluate("window.foregroundFixture.draft()");
          await pause(100);
          const draft = await evaluate("window.foregroundFixture.state()");
          assert(draft.text === "Unsent foreground draft", `${arm}: composer editing failed`);
          win.webContents.send("openteam:window-activity-changed", false);
          await pause(100);
          win.webContents.send("openteam:window-activity-changed", true);
          await pause(100);
          const resumed = await evaluate("window.foregroundFixture.state()");
          assert(resumed.text === draft.text && resumed.editorFocused === draft.editorFocused && JSON.stringify(resumed.selection) === JSON.stringify(draft.selection), `${arm}: pause/resume changed draft, caret selection, or focus`);
          reports.push({ name: `${theme}-${width}-draft`, passed: true });
          // Each scenario starts from a fresh component tree and draft.
          await evaluate("window.foregroundFixture.render('voice-processing')");
          await pause(100);
        }
        if (arm === "candidate") {
          const baseline = nativeImage.createFromPath(path.join(output, `baseline-${name}.png`));
          const candidate = nativeImage.createFromPath(path.join(output, `candidate-${name}.png`));
          const a = baseline.toBitmap(), b = candidate.toBitmap();
          assert(a.length === b.length && a.length > 0, `${name}: screenshot dimensions differ`);
          let differentPixels = 0, maxChannelDifference = 0;
          for (let i = 0; i < a.length; i += 4) {
            let different = false;
            for (let c = 0; c < 4; c++) { const delta = Math.abs(a[i+c] - b[i+c]); maxChannelDifference = Math.max(maxChannelDifference, delta); different ||= delta !== 0; }
            if (different) differentPixels++;
          }
          const baselineState = JSON.parse(fs.readFileSync(path.join(output, `baseline-${name}.json`)));
          const geometryEqual = JSON.stringify(state.rects) === JSON.stringify(baselineState.rects);
          const canvasesEqual = JSON.stringify(state.canvases) === JSON.stringify(baselineState.canvases);
          reports.push({ name, differentPixels, maxChannelDifference, geometryEqual, canvasesEqual });
        }
      }
      win.destroy();
    }
    assert(rendererErrors.length === 0, `${arm}: renderer errors: ${rendererErrors.join("; ")}`);
    fs.writeFileSync(path.join(output, `${arm}-results.json`), JSON.stringify(reports, null, 2));
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
