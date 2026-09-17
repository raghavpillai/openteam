const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const reduced = process.argv.includes("--reduced");
const scale = process.argv.includes("--scale=1") ? 1 : 2;
const root = path.resolve(process.argv[2]);
const out = path.join(
  root,
  (reduced ? "reduced-render" : "normal-render") + (scale === 1 ? "-1x" : "")
);
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(root, reduced ? "reduced-profile" : "profile"));
if (reduced) app.commandLine.appendSwitch("force-prefers-reduced-motion");
const results = {
  method:
    "Isolated offscreen Electron renderer of shipping OpenTeam component. No desktop or GrokBot window recording.",
  reduced,
  scale,
  states: {},
  console: [],
};
app.whenReady().then(async () => {
  const partition = "template-audit-" + Date.now();
  session
    .fromPartition(partition)
    .webRequest.onBeforeRequest((details, done) =>
      done({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("data:") })
    );
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: 985,
    height: 960,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition,
    },
  });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") results.console.push(event.message);
  });
  const call = (method, ...args) =>
    win.webContents.executeJavaScript(
      `window.templateAudit[${JSON.stringify(method)}](...${JSON.stringify(args)})`
    );
  let zoom = 1;
  const resizeViewport = (width, height) =>
    win.setContentSize(Math.round(width * zoom), Math.round(height * zoom));
  const capture = async (name, state) => {
    results.states[name] = state;
    const rendered = await win.webContents.capturePage();
    results.states[name].captureSize = rendered.getSize();
    fs.writeFileSync(path.join(out, name + ".png"), rendered.toPNG());
  };
  try {
    await win.loadFile(path.join(root, "fixture-build/test/browser/pixel-motion.html"));
    // Offscreen macOS windows can use a 1× backing store. Browser zoom plus a
    // proportionally larger viewport renders actual 2× pixels, including 0.5px
    // borders; emulating devicePixelRatio alone does not change that rounding.
    results.baseDevicePixelRatio = await win.webContents.executeJavaScript("devicePixelRatio");
    zoom = scale / results.baseDevicePixelRatio;
    results.zoomFactor = zoom;
    resizeViewport(985, 960);
    win.webContents.setZoomFactor(zoom);
    await new Promise((r) => setTimeout(r, 350));
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(__dirname, "template-motion-checks.js"), "utf8")
    );
    results.actualReduced = await win.webContents.executeJavaScript(
      "matchMedia('(prefers-reduced-motion: reduce)').matches"
    );
    results.devicePixelRatio = await win.webContents.executeJavaScript("devicePixelRatio");
    if (results.devicePixelRatio !== scale) throw new Error(`Expected ${scale}× renderer scale`);
    if (results.actualReduced !== reduced) throw new Error("Unexpected reduced-motion preference");
    for (const theme of ["light", "dark"]) {
      await capture(theme + "-overview", await call("open", theme));
      await capture(theme + "-context", await call("context"));
      await capture(theme + "-fact", await call("fact", theme === "dark" ? 1 : 0));
      await call("back");
      await call("rapid");
      await call("close");
    }
    await call("rich");
    await capture("empty", await call("empty"));
    await call("close");
    await capture("pending", await call("pending"));
    await call("close");
    resizeViewport(390, 600);
    await capture("narrow", await call("narrow"));
    await call("close");
    results.checks = await win.webContents.executeJavaScript("window.templateAudit.checks");
    results.traces = await call("motion");
    results.passed = results.checks.filter((c) => c.passed).length;
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ passed: results.passed, reduced, artifacts: out }));
    app.quit();
  } catch (e) {
    results.error = String(e);
    results.failureState = await win.webContents
      .executeJavaScript(`({ state: window.templateAudit?.state(), devicePixelRatio,
        border: getComputedStyle(document.querySelector('.template-details')).borderWidth,
        classes: document.querySelector('.template-details').className })`)
      .catch(() => null);
    results.checks = await win.webContents
      .executeJavaScript("window.templateAudit?.checks??[]")
      .catch(() => []);
    fs.writeFileSync(path.join(out, "failure.png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
    console.error(e);
    app.exit(1);
  }
});
