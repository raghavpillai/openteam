// Electron entry for the fixture checks in scripts/test-fixtures.ts. FIXTURE_DRIVER names a
// module in this directory, `async (fixture) => result`, that drives the window; without one
// the page reports its own result with console.log("FIXTURE_RESULT " + JSON.stringify(result)).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { FIXTURE_DIR: directory, FIXTURE_URL: url, FIXTURE_DRIVER: driver } = process.env;
app.setPath("userData", path.join(directory, "profile"));
app.on("window-all-closed", () => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let reported = () => {};
const fixture = {
  directory,
  url,
  pause,
  /** Renderer console errors and preload failures, for drivers that require none. */
  errors: [],
  win: null,
  open({ width = 1040, height = 960, ...webPreferences } = {}) {
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: { backgroundThrottling: false, ...webPreferences },
    });
    win.webContents.on("console-message", ({ level, message }) => {
      if (message.startsWith("FIXTURE_RESULT ")) reported(JSON.parse(message.slice(15)));
      else if (level === "error") fixture.errors.push(message);
    });
    win.webContents.on("preload-error", (_event, _path, error) => fixture.errors.push(error.message));
    return (fixture.win = win);
  },
  js: (source) => fixture.win.webContents.executeJavaScript(source),
  async until(source, message = `Timed out: ${source}`, timeout = 8000) {
    for (const started = Date.now(); Date.now() - started < timeout; await pause(25))
      if (await fixture.js(source)) return;
    throw new Error(message);
  },
  async check(source, message) {
    if (!(await fixture.js(source))) throw new Error(message);
  },
  /** Load the page with extra query parameters and wait for `window.fixture.ready`. */
  async load(query = "") {
    await fixture.win.loadURL(url + query);
    await fixture.until("window.fixture?.ready", "Fixture page never became ready", 15_000);
    await pause(400);
  },
  /** A real mouse click on the element `expression` returns, then let exit animations finish. */
  async click(expression) {
    const point = await fixture.js(
      `(()=>{const el=${expression}; if(!el) throw new Error('Click target missing: ' + ${JSON.stringify(expression)}); const b=el.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`
    );
    fixture.win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    fixture.win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await pause(150);
    // The window is hidden; request a frame before waiting for finite animations.
    await fixture.win.webContents.capturePage();
    await fixture.js(
      "Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)))"
    );
  },
  /** Expression for the first button whose trimmed text is exactly `text`. */
  button: (text) =>
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`,
};

async function selfReporting({ open }) {
  const result = new Promise((resolve) => (reported = resolve));
  await open().loadURL(url);
  return result;
}

const write = (result) =>
  fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(result));
app
  .whenReady()
  .then(() => (driver ? require(path.join(__dirname, driver)) : selfReporting)(fixture))
  .then(
    (result) => {
      write(result);
      app.exit(0);
    },
    (error) => {
      write({ error: String(error?.message ?? error), stack: error?.stack });
      app.exit(1);
    }
  );
