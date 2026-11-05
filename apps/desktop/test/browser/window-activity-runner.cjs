const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.WINDOW_ACTIVITY_DIR, "profile"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: {
    backgroundThrottling: false, preload: path.join(process.env.WINDOW_ACTIVITY_DIR, "preload.cjs")
  } });
  // Drive the native signals through the shipping preload, without stealing
  // OS focus from the developer or depending on the desktop's window manager.
  let nativeVisible = true;
  let nativeActive = true;
  ipcMain.handle("openteam:window-visibility", () => nativeVisible);
  ipcMain.handle("openteam:window-activity", () => nativeActive);
  const signal = (visible, focused) => {
    nativeVisible = visible;
    nativeActive = visible && focused;
    win.webContents.send("openteam:window-visibility-changed", nativeVisible);
    win.webContents.send("openteam:window-activity-changed", nativeActive);
  };
  const evaluate = source => win.webContents.executeJavaScript(source);
  const read = () => evaluate("window.activityProbe?.()");
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (value && predicate(value)) return value;
      await pause(100);
    }
    throw Error("Window activity did not reach expected state: " + JSON.stringify(await read()));
  };
  try {
    await win.loadURL(process.env.WINDOW_ACTIVITY_URL);
    const initial = await waitFor(p => p.active && p.avatar === "idle" && p.paints.length >= 3 && p.paints.every(n => n > 2));
    signal(true, false);
    await waitFor(p => !p.active && p.avatar === "still");
    await pause(150);
    const background = await read();
    await evaluate("window.tickPollers()");
    await pause(300);
    const quiet = await read();
    assert(quiet.visible && quiet.inactiveAttribute, "An unfocused shown window must pause without changing transport visibility");
    assert(JSON.stringify(quiet.paints) === JSON.stringify(background.paints), "All orb and voice canvases must stop painting in the background");
    assert(quiet.pluginReads === background.pluginReads && quiet.updateReads === background.updateReads, "Idle polling must stop in the background");
    await evaluate("window.beginUpdate()");
    await pause(100);
    await evaluate("window.tickPollers()");
    await pause(100);
    const updating = await read();
    assert(updating.updateReads > quiet.updateReads, "An active server update must still be monitored in the background");
    signal(true, true);
    await waitFor(p => p.active && p.avatar === "idle");
    const resumed = await read();
    await evaluate("window.tickPollers()");
    await pause(300);
    const foreground = await read();
    assert(!foreground.inactiveAttribute, "Foreground CSS must not be paused");
    assert(foreground.paints.every((n, i) => n > resumed.paints[i]), "Every canvas must resume painting in the foreground");
    assert(foreground.pluginReads > resumed.pluginReads, "Foreground polling must resume");
    await evaluate("window.startRecording()");
    await pause(150);
    signal(true, false);
    await waitFor(p => !p.active && p.avatar === "still");
    await pause(150);
    const recordingBackground = await read();
    await pause(200);
    const recordingQuiet = await read();
    assert(recordingQuiet.recordingTrackLive, "Background visualizer cleanup must leave the recording's original audio track live");
    assert(JSON.stringify(recordingQuiet.paints) === JSON.stringify(recordingBackground.paints), "Recording visualizers must also stop painting in the background");
    signal(false, false);
    await waitFor(p => !p.active && p.avatar === "still");
    signal(true, true);
    await waitFor(p => p.active && p.avatar === "idle");
    fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_DIR, "results.json"), JSON.stringify({ passed: true, initial, background: quiet, updating, foreground }));
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
