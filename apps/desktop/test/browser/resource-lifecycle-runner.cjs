const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.RESOURCE_LIFECYCLE_DIR;
app.setPath("userData", path.join(directory, "profile"));
let visible = true;
let active = true;
ipcMain.handle("openteam:window-visibility", () => visible);
ipcMain.handle("openteam:window-activity", () => active);
ipcMain.handle("openteam:delivery-journal:read", () => null);
ipcMain.handle("openteam:delivery-journal:write", () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(directory, "preload.cjs"),
    },
  });
  const reports = [];
  const rendererErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  const evaluate = (source) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      throw Error(source + "\n" + error.message);
    });
  const read = () => evaluate("window.resourceProbe?.()");
  const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let index = 0; index < 300; index++) {
      const value = await read();
      if (value && predicate(value)) return value;
      await pause();
    }
    throw Error("Lifecycle state timed out " + JSON.stringify(await read()));
  };
  const check = (value, message) => {
    if (!value) throw Error(message + " " + JSON.stringify(reports));
    reports.push(message);
  };
  const signal = async (shown, focused) => {
    visible = shown;
    active = shown && focused;
    win.webContents.send("openteam:window-visibility-changed", visible);
    win.webContents.send("openteam:window-activity-changed", active);
    await waitFor((value) => value.visible === visible && value.active === active);
    await pause();
  };
  const render = (options) => evaluate(`window.renderResources(${JSON.stringify(options)})`);
  const advance = async (ms) => {
    await evaluate(`window.advanceResourceClock(${ms})`);
    await pause();
  };
  try {
    await win.loadURL(process.env.RESOURCE_LIFECYCLE_URL);
    await waitFor((value) => value.active && value.canvasCount > 0);
    await render({
      sources: ["/api/fixture/image", "/api/fixture/image"],
      retain: "bot-a",
      group: true,
    });
    let value = await waitFor(
      (value) => value.sources.length === 2 && value.sources.every(Boolean)
    );
    const shared = value.sources[0];
    check(
      value.sources[1] === shared && value.requests.length === 1,
      "two consumers share one authenticated request and blob URL under StrictMode"
    );
    await signal(true, false);
    await advance(10_000);
    value = await read();
    check(
      value.sources[0] === shared && value.canvasCount > 0,
      "focus loss retains visible resources and the static orb"
    );
    check(
      value.intervals.includes(1_000) && !value.intervals.includes(2_000),
      "visible UI clocks continue while decorative group cycling stops on blur"
    );
    await render({ sources: ["/api/fixture/image"], retain: "bot-a" });
    await advance(60_000);
    check(
      (await read()).sources[0] === shared,
      "releasing one consumer and expiring idle deadlines preserves a still-displayed image"
    );
    await render({ sources: ["/api/fixture/hold-refresh"], retain: "bot-a" });
    check(
      (await read()).sources[0] === shared,
      "screen refresh retains the prior frame while its replacement loads"
    );
    await evaluate("window.completeResourceFetches()");
    value = await waitFor((value) => value.sources[0] && value.sources[0] !== shared);
    const refreshed = value.sources[0];
    await render({ sources: ["/api/fixture/hold-other-bot"], retain: "bot-b" });
    check(
      !(await read()).sources[0],
      "changing retention owner immediately removes the previous bot's frame"
    );
    await evaluate("window.completeResourceFetches()");
    await waitFor((value) => value.sources[0] && value.sources[0] !== refreshed);
    await render({ sources: ["/api/fixture/image"], viewActive: false });
    await advance(31_000);
    value = await read();
    check(
      !value.sources[0] && value.canvasCount === 0,
      "an inactive view releases its image consumer and orb canvas after the grace period"
    );
    await render({ sources: ["/api/fixture/image"], viewActive: true });
    await waitFor((value) => value.sources[0] && value.canvasCount > 0);
    await signal(false, false);
    check(
      !(await read()).intervals.includes(1_000),
      "hiding the window clears the UI clock interval"
    );
    await advance(31_000);
    value = await read();
    check(
      !value.sources[0] && value.canvasCount === 0,
      "a hidden window releases optional presentation after the grace period"
    );
    await signal(true, false);
    value = await waitFor((value) => value.sources[0] && value.canvasCount > 0);
    check(
      value.intervals.includes(1_000) && !value.active,
      "showing without focus restores content and catches up UI clocks"
    );
    const beforeSignOut = value.sources[0];
    const requestsBeforeSignOut = value.requests.length;
    await evaluate("window.signOutResourceFixture()");
    value = await waitFor((value) => value.sources[0] && value.sources[0] !== beforeSignOut);
    check(
      value.requests.length > requestsBeforeSignOut,
      "credential changes invalidate shared resources and fetch a fresh URL"
    );
    const oldUrlReadable = await evaluate(
      `fetch(${JSON.stringify(beforeSignOut)}).then(() => true, () => false)`
    );
    check(!oldUrlReadable, "the prior credential's blob is revoked after React replaces it");

    await signal(true, true);
    await render({ screen: true });
    await evaluate(
      `document.querySelector(${JSON.stringify('button[aria-label="Open computer"]')}).click()`
    );
    value = await waitFor((value) => value.vnc?.live === 1);
    const initialConnections = value.vnc.connections;
    await signal(true, false);
    check((await read()).vnc.live === 1, "a visible unfocused computer keeps its live connection");
    await signal(false, false);
    value = await waitFor((value) => value.vnc.live === 0);
    check(
      value.vnc.disconnections === initialConnections,
      "hiding the computer disconnects its VNC decoder"
    );
    const takeovers = value.takeovers;
    await pause(20_100);
    check(
      (await read()).takeovers === takeovers,
      "the hidden computer does not acquire or renew control"
    );
    await signal(true, false);
    value = await waitFor((value) => value.vnc.live === 1);
    check(
      value.vnc.connections === initialConnections + 1,
      "showing the computer reconnects through the normal session path"
    );

    await signal(true, true);
    await evaluate("window.renderResourceChat()");
    await waitFor((value) => value.draft !== null);
    await evaluate(
      `window.testDraftEditor = document.querySelector('[contenteditable="true"][role="textbox"]'); window.testDraftEditor.focus()`
    );
    win.webContents.insertText("A draft survives resource parking");
    await waitFor((value) => value.draft.includes("A draft survives resource parking"));
    await evaluate(`(() => {
      const node = document.createTreeWalker(window.testDraftEditor, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 8);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    })()`);
    await signal(false, false);
    await advance(31_000);
    check(
      (await read()).draft.includes("A draft survives resource parking"),
      "parking real chat resources preserves the composer draft"
    );
    await signal(true, true);
    await waitFor((value) => value.sources[0] && value.canvasCount > 0);
    const editorRestored = await evaluate(
      `document.activeElement === window.testDraftEditor && getSelection().anchorOffset === 2 && getSelection().focusOffset === 8`
    );
    check(
      editorRestored,
      "real composer focus and caret selection survive hidden resource parking and resume"
    );
    await evaluate("delete window.testDraftEditor");
    await render({});
    await signal(true, true);
    await evaluate('window.highlightResourceCode("const answer: number = 42;", "typescript")');
    await waitFor((value) => value.highlightDone === 1);
    await evaluate("window.cacheResourceCode()");
    await waitFor((value) => value.stats.tokenEntries > 0);
    await evaluate("window.captureWorkerError()");
    await signal(false, false);
    await advance(31_000);
    value = await read();
    check(
      value.workers === 0 && value.stats.highlighterEntries === 0,
      "a background idle highlighter terminates and releases its grammar isolate"
    );
    check(value.stats.tokenEntries > 0, "worker eviction preserves rendered token results");
    await evaluate('window.highlightResourceCode("print(42)", "python")');
    await waitFor((value) => value.highlightDone === 2 && value.workers === 1);
    await evaluate("window.emitStaleWorkerError()");
    check(
      (await read()).workers === 1,
      "an old worker callback cannot reset the replacement worker"
    );
    await advance(20_000);
    await evaluate(
      'window.holdHighlightResponses(true); window.highlightResourceCode("const third = 3;", "typescript")'
    );
    await waitFor((value) => value.heldMessages > 0);
    await advance(11_000);
    value = await read();
    check(
      value.workers === 1 && value.highlightDone === 2 && !value.highlightError,
      "new work cancels idle eviction while a response is pending"
    );
    await evaluate("window.holdHighlightResponses(false)");
    await waitFor((value) => value.highlightDone === 3);
    await signal(true, true);
    await advance(31_000);
    check(
      (await read()).workers === 1,
      "returning to the foreground cancels pending idle eviction"
    );
    const creations = (await read()).workerCreations;
    for (let index = 0; index < 20; index++) {
      await signal(false, false);
      await signal(true, true);
    }
    check(
      (await read()).workerCreations === creations,
      "twenty quick background cycles preserve the warm worker"
    );
    await signal(false, false);
    await advance(31_000);
    await evaluate("window.unmountResources()");
    await advance(31_000);
    value = await read();
    check(
      value.workers === 0 &&
        value.intervals.length === 0 &&
        value.longTimers === 0 &&
        value.vnc.live === 0,
      "unmount and idle expiry release workers, intervals, resource deadlines and VNC clients"
    );
    check(!value.highlightError, "all real worker requests complete without highlighting errors");
    check(value.errors.length === 0, "resource parking and resume finish without renderer errors or unhandled rejections");
    await evaluate("window.disposeResources()");
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ reports }, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, "results.json"),
      JSON.stringify(
        {
          reports,
          error: error.stack,
          rendererErrors,
          html: await evaluate("document.body.innerHTML").catch(() => null),
          probe: await read().catch(() => null),
        },
        null,
        2
      )
    );
    app.exit(1);
  }
});
