const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", path.join(process.env.WINDOW_ACTIVITY_DIR, "profile"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: {
    backgroundThrottling: false, preload: path.join(process.env.WINDOW_ACTIVITY_DIR, "preload.cjs")
  } });
  const { bindWindowActivity } = require(path.join(process.env.WINDOW_ACTIVITY_DIR, "window-activity.cjs"));
  // Match production shutdown: closed runs after BrowserWindow is destroyed.
  const closingWindow = new BrowserWindow({ show: false });
  const closingContents = closingWindow.webContents;
  const dispose = bindWindowActivity(closingWindow);
  closingWindow.once("closed", dispose);
  closingWindow.destroy();
  assert(closingContents.listenerCount("did-finish-load") === 0, "closing a native window must release activity listeners without reading a destroyed BrowserWindow");
  // Drive the native signals through the shipping preload, without stealing
  // OS focus from the developer or depending on the desktop's window manager.
  let nativeVisible = false;
  let nativeActive = false;
  let holdInitial = true;
  const nativeMode = process.env.WINDOW_ACTIVITY_NATIVE === "1";
  const initialReplies = [];
  const initial = value => holdInitial ? new Promise(resolve => initialReplies.push(() => resolve(value))) : value;
  ipcMain.handle("openteam:window-visibility", () => nativeMode ? win.isVisible() && !win.isMinimized() : initial(nativeVisible));
  ipcMain.handle("openteam:window-activity", () => nativeMode ? win.isVisible() && !win.isMinimized() && win.isFocused() : initial(nativeActive));
  const signal = (visible, focused) => {
    nativeVisible = visible;
    nativeActive = visible && focused;
    win.webContents.send("openteam:window-visibility-changed", nativeVisible);
    win.webContents.send("openteam:window-activity-changed", nativeActive);
  };
  const evaluate = source => win.webContents.executeJavaScript(source);
  const read = () => evaluate(process.env.WINDOW_ACTIVITY_SYNC === "1" ? "window.syncProbe?.()" : "window.activityProbe?.()");
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (value && predicate(value)) return value;
      await pause(100);
    }
    throw Error("Window activity did not reach expected state: " + JSON.stringify(await read()));
  };
  if (process.env.WINDOW_ACTIVITY_SYNC === "1") {
    holdInitial = false; nativeVisible = true; nativeActive = true;
    const { DesktopNotificationManager } = require(path.join(process.env.WINDOW_ACTIVITY_DIR, "notifications.cjs"));
    const delivered = [], dismissed = [];
    const notifications = new DesktopNotificationManager({isFocused:()=>nativeActive,isSupported:()=>true,
      deliver:event=>delivered.push(event),dismiss:id=>dismissed.push(id),setBadge:()=>{}});
    ipcMain.on("openteam:notifications:sync", (_event, snapshot) => notifications.sync(snapshot));
    ipcMain.on("openteam:notifications:clear", () => notifications.clear());
    let journal = null;
    ipcMain.handle("openteam:delivery-journal:read", () => journal);
    ipcMain.handle("openteam:delivery-journal:write", (_event, request) => { journal = request.journal; });
    const reports = [];
    const check = (condition, message) => {assert(condition,message); reports.push(message);};
    try {
      await win.loadURL(process.env.WINDOW_ACTIVITY_URL);
      await waitFor(p => p.cursor === "1" && p.connections === 1);
      signal(true, false); await pause(100);
      await evaluate("window.advanceRuntime(); window.tickRuntime()"); await pause(100);
      check((await read()).runtimeReads === 0, "runtime status polling skips an unfocused window");
      signal(false, false); await pause(100);
      await evaluate("window.injectNotification()");
      await waitFor(p => p.cursor === "2"); await pause(100);
      check(delivered.length === 1 && delivered[0].body === "Completed in the background", "a hidden window still receives product events and delivers a native notification projection");
      check((await read()).connections === 1 && (await read()).aborts === 0, "backgrounding does not abort or reconnect the live product stream");
      await evaluate("window.markReadElsewhere()"); await waitFor(p => p.cursor === "3"); await pause(100);
      check(dismissed.length === 1, "remote read state dismisses the delivered notification while hidden");
      await evaluate("window.disconnectStream()"); await waitFor(p => p.connections === 2);
      check((await read()).cursors[1] === "3", "the hidden live stream reconnects from the latest committed cursor");
      await evaluate("window.queueOffline()");
      check((await read()).sendCount === 0, "an offline message remains queued while the window is hidden");
      await evaluate("window.reconnectDelivery()"); await waitFor(p => p.sendCount === 1 && p.deliveries.includes("accepted-awaiting-echo"));
      check(true, "delivery reconnect flushes the queued message without foregrounding the window");
      await evaluate("window.acknowledgeDelivery()"); await waitFor(p => p.deliveries.length === 0);
      check((await read()).sendCount === 1, "the background message is acknowledged without duplicate dispatch");
      await evaluate("window.advanceRuntime()"); signal(true,true);
      await waitFor(p => p.runtimeReads > 0);
      check(true, "native foreground resume immediately refreshes overdue runtime status");
      await evaluate("window.unmountSync()"); await pause(100);
      const final = await read();
      check(final.aborts > 0 && final.errors.length === 0, "unmount aborts the stream without renderer errors");
      const result = JSON.stringify({passed:reports.length,reports,delivered,dismissed,final},null,2);
      fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_DIR,"results.json"),result);
      fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_OUTPUT,"background-sync.json"),result);
      app.quit();
    } catch(error) {console.error(error); app.exit(1);}
    return;
  }
  if (nativeMode) {
    bindWindowActivity(win);
    const events = [];
    let finishing = false;
    const save = async (event = "sample") => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      const state = { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(),
        event, probe: await read(), events: events.slice() };
      fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_OUTPUT, "native-state.json"), JSON.stringify(state, null, 2));
      fs.appendFileSync(path.join(process.env.WINDOW_ACTIVITY_OUTPUT, "native-events.jsonl"), JSON.stringify(state) + "\n");
    };
    for (const event of ["show", "hide", "minimize", "restore", "focus", "blur"]) {
      win.on(event, () => { events.push(event); void save(event).catch(console.error); setTimeout(() => save(`${event}-settled`).catch(console.error), 100); });
    }
    const cover = new BrowserWindow({show:false,width:400,height:220,title:"QA cover window",webPreferences:{preload:path.join(process.env.WINDOW_ACTIVITY_DIR,"preload.cjs")}});
    await cover.loadURL('data:text/html,<h1>QA cover window</h1><button onclick="window.activityQA.restore()">Return to OpenTeam QA</button><button onclick="window.activityQA.quit()">Finish native test</button>');
    ipcMain.on("qa:cover", () => { cover.show(); cover.focus(); });
    ipcMain.on("qa:restore", () => { cover.hide(); win.restore(); win.show(); win.focus(); });
    ipcMain.on("qa:hide", () => { win.hide(); cover.show(); cover.focus(); });
    ipcMain.on("qa:quit", async () => {
      finishing = true;
      await save();
      fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_DIR,"results.json"), JSON.stringify({native:true,events}));
      app.quit();
    });
    win.on("close", event => { if (!finishing) { event.preventDefault(); win.hide(); cover.show(); } });
    await win.loadURL(process.env.WINDOW_ACTIVITY_URL);
    win.setTitle("OpenTeam Background QA");
    win.show();
    await pause(500);
    await save();
    return;
  }
  const reports = [];
  const check = (condition, message) => { assert(condition, message); reports.push(message); };
  const background = async () => {
    signal(true, false);
    await waitFor(p => !p.active && p.avatar === "still");
    await waitFor(p => p.resources.frames === 0 && p.resources.visualizerTracks === 0);
    await pause(100);
    const before = await read();
    await pause(100);
    const after = await read();
    assert(JSON.stringify(before.paints) === JSON.stringify(after.paints), "background canvas paints must remain stationary");
    assert(after.resources.frames === 0, "background must have no scheduled decorative RAFs");
    assert(after.resources.visualizerTracks === 0, "background must release cloned visualizer tracks");
    return after;
  };
  try {
    if (process.env.WINDOW_ACTIVITY_REDUCED === "1") {
      await win.loadURL("about:blank");
      win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    }
    await win.loadURL(process.env.WINDOW_ACTIVITY_URL);
    await waitFor(p => p.paints.length >= 4);
    signal(true, true);
    const initial = await waitFor(p => p.active && p.avatar === "idle" && p.paints.some(n => n > 2));
    holdInitial = false;
    initialReplies.forEach(resolve => resolve());
    await pause(100);
    check((await read()).active, "late initial IPC replies cannot override a newer foreground signal");
    const foregroundResources = (await read()).resources;
    const quiet = await background();
    check(quiet.visible && quiet.inactiveAttribute, "unfocused shown windows pause decoration without changing notification visibility");
    await evaluate("window.tickPollers()");
    await pause(100);
    const idle = await read();
    check(idle.pluginReads === quiet.pluginReads && idle.updateReads === quiet.updateReads, "idle polling stops in the background");
    await evaluate("window.beginUpdate()");
    await pause(100);
    await evaluate("window.tickPollers()");
    await pause(100);
    check((await read()).updateReads > idle.updateReads, "active server updates keep polling in the background");
    await evaluate("window.updateOffline()");
    await pause(100);
    const offline = await read();
    await evaluate("window.tickPollers()");
    await pause(100);
    check((await read()).updateReads > offline.updateReads, "an active update keeps reconnecting through a background server outage");
    await evaluate("window.updateIdle()");
    await pause(100);
    const restoredIdle = await read();
    await evaluate("window.tickPollers()");
    await pause(100);
    check((await read()).updateReads === restoredIdle.updateReads, "idle background polling stops again after update completion");
    signal(true, true);
    await waitFor(p => p.active && p.avatar === "idle");
    const resumed = await read();
    await evaluate("window.tickPollers()");
    await pause(200);
    const foreground = await read();
    check(!foreground.inactiveAttribute && foreground.paints.some((n,i) => n > resumed.paints[i]), "foreground animations and canvas paints resume");
    check(foreground.pluginReads > resumed.pluginReads, "foreground polling resumes");
    const pausedPaints = await evaluate("(() => {const c=document.querySelector('canvas[aria-label=\"Explicitly paused\"]');return window.activityProbe().paints[[...document.querySelectorAll('canvas')].indexOf(c)]})()");
    await pause(150);
    const pausedAfter = await evaluate("(() => {const c=document.querySelector('canvas[aria-label=\"Explicitly paused\"]');return window.activityProbe().paints[[...document.querySelectorAll('canvas')].indexOf(c)]})()");
    check(pausedPaints === pausedAfter, "an explicitly paused orb stays paused in the foreground");
    for (let cycle = 0; cycle < 100; cycle++) {
      signal(cycle % 3 !== 0, false);
      await waitFor(p => !p.active && p.avatar === "still");
      signal(true, true);
      await waitFor(p => p.active && p.avatar === "idle");
    }
    await pause(100);
    const cycled = await read();
    check(JSON.stringify(cycled.resources.listeners) === JSON.stringify(foregroundResources.listeners), "100 focus/hide/restore cycles do not accumulate window/document listeners");
    check(JSON.stringify(cycled.resources.observers) === JSON.stringify(foregroundResources.observers), "100 focus/hide/restore cycles do not accumulate observers");
    check(cycled.resources.intervals === foregroundResources.intervals, "100 cycles do not accumulate polling intervals");
    await evaluate("window.startRecording()");
    await pause(100);
    const recordingQuiet = await background();
    check(recordingQuiet.recordingTrackLive, "pausing voice decoration leaves the synthetic source track live");
    signal(true, true);
    await waitFor(p => p.active);
    await evaluate("window.startVoice()");
    await waitFor(p => p.voiceState === "recording");
    await pause(650);
    await background();
    const voiceBefore = await read();
    await pause(1200);
    const voiceAfter = await read();
    check(voiceAfter.voiceState === "recording" && voiceAfter.voiceElapsed > voiceBefore.voiceElapsed, "the real MediaRecorder and elapsed timer continue in the background");
    check(voiceAfter.captureTracks.at(-1) === "live", "the recorder's original captured track remains live while decoration is paused");
    await evaluate("window.stopVoice()");
    const encoded = await waitFor(p => p.voiceState === "processing" && p.transcription !== null);
    check(encoded.transcription.bytes > 100 && encoded.transcription.duration > 1 && encoded.transcription.peak > 0.1, "background Stop produces decodable non-silent encoded audio");
    signal(false, false);
    await evaluate("window.finishTranscription()");
    await waitFor(p => p.voiceState === "idle" && p.transcript === "Background recording survived");
    check(true, "transcription completes and preserves its draft callback while the window is hidden");
    signal(true, true);
    await waitFor(p => p.active);
    await evaluate("window.startVoice()");
    await waitFor(p => p.voiceState === "recording");
    await background();
    await evaluate("window.cancelVoice()");
    await waitFor(p => p.voiceState === "idle");
    check((await read()).captureTracks.every(state => state === "ended"), "background cancellation releases every captured recording track");
    await evaluate("window.disposeActivity()");
    const disposed = await waitFor(p => p.resources.frames === 0 && p.resources.intervals === 0 && p.resources.visualizerTracks === 0);
    check(disposed.resources.frames === 0 && disposed.resources.intervals === 0 && disposed.resources.visualizerTracks === 0, "unmount removes decorative frames, polling intervals, and cloned tracks: " + JSON.stringify(disposed.resources));
    check(Object.values(disposed.resources.observers).every(count => count === 0), "unmount disconnects every observed DOM resource");
    check(Object.values(disposed.resources.listeners).every(count => count === 0), "unmount removes activity/focus/visibility listeners");
    signal(true, true);
    await evaluate("window.reinstallActivity()");
    await waitFor(p => p.active && p.avatar === "idle");
    check((await read()).errors.length === 0, "all lifecycle scenarios finish without renderer errors or unhandled rejections");
    const result = { passed: reports.length, reducedMotion: process.env.WINDOW_ACTIVITY_REDUCED === "1", reports, initial, foreground, cycled, disposed, recording: encoded.transcription };
    const serialized = JSON.stringify(result, null, 2);
    fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_DIR, "results.json"), serialized);
    fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_OUTPUT, process.env.WINDOW_ACTIVITY_REDUCED === "1" ? "reduced-motion.json" : "normal-motion.json"), serialized);
    app.quit();
  } catch (error) {
    fs.writeFileSync(path.join(process.env.WINDOW_ACTIVITY_OUTPUT, "failure-state.json"), JSON.stringify(await read(), null, 2));
    console.error(error);
    app.exit(1);
  }
});
