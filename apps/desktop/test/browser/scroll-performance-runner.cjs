const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(configuration.output, "electron-profile"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const runs = [];
// Keep Electron alive between the fresh renderer processes in each arm.
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // Alternating order reduces warm-up/order bias. Every arm gets a fresh renderer.
    for (const [pair, order] of [
      [1, ["before", "after"]],
      [2, ["after", "before"]],
      [3, ["before", "after"]],
    ]) {
      for (const arm of order) {
        const win = new BrowserWindow({
          show: true,
          width: 1050,
          height: 850,
          webPreferences: { backgroundThrottling: false },
        });
        app.focus({ steal: true });
        win.focus();
        const js = (code) => win.webContents.executeJavaScript(code);
        const cdp = (method, params = {}) => win.webContents.debugger.sendCommand(method, params);
        await win.loadURL(configuration.urls[arm]);
        win.webContents.focus();
        win.webContents.debugger.attach("1.3");
        await cdp("Performance.enable");
        const metric = async () =>
          Object.fromEntries(
            (await cdp("Performance.getMetrics")).metrics.map((m) => [m.name, m.value])
          );
        const heap = async () => {
          await cdp("HeapProfiler.collectGarbage");
          return (await cdp("Runtime.getHeapUsage")).usedSize;
        };
        for (const mode of ["text", "rich", "media", "thread"]) {
          await js(`window.scrollHarness.mount(${JSON.stringify(mode)},false)`);
          await pause(600);
          const target = mode === "text" ? 950 : mode === "thread" ? 275 : 200;
          await js(`window.scrollHarness.focus(${target})`);
          await pause(1800);
          const initial = await js("window.scrollHarness.sample()");
          if (!initial.ready || !initial.rows.some((row) => row.id === target))
            throw Error(`${arm}/${mode}: target not ready`);
          const heapBefore = await heap();
          await pause(250);
          const before = await metric();
          await js(`(() => {
          const deltas=[],longTasks=[];let last=0,raf;
          const tick=at=>{if(last)deltas.push(at-last);last=at;raf=requestAnimationFrame(tick);};
          raf=requestAnimationFrame(tick);
          const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
          observer.observe({type:'longtask'});
          window.finishScrollProfile=()=>{cancelAnimationFrame(raf);observer.disconnect();return {deltas,longTasks,visible:document.visibilityState,focused:document.hasFocus()};};
        })()`);
          const x = Math.round(initial.x),
            y = Math.round(initial.y);
          win.webContents.sendInputEvent({ type: "mouseMove", x, y });
          let low = Infinity,
            high = -Infinity,
            maxMounted = 0;
          for (let cycle = 0; cycle < 6; cycle++)
            for (const older of [true, false]) {
              for (let step = 0; step < 8; step++) {
                win.webContents.sendInputEvent({
                  type: "mouseWheel",
                  x,
                  y,
                  deltaX: 0,
                  deltaY: older ? 120 : -120,
                  canScroll: true,
                });
                await pause(20);
              }
              await pause(200);
              // Geometry only at phase boundaries, outside the per-frame observer.
              const sample = await js("window.scrollHarness.sample()");
              if (!sample.rows.length) throw Error("Blank settled viewport");
              low = Math.min(low, ...sample.rows.map((row) => row.id));
              high = Math.max(high, ...sample.rows.map((row) => row.id));
              maxMounted = Math.max(maxMounted, sample.mounted);
            }
          const cadence = await js("window.finishScrollProfile()");
          const after = await metric();
          const heapAfter = await heap();
          const dom = await cdp("Memory.getDOMCounters");
          if (cadence.visible !== "visible" || !cadence.focused)
            throw Error(
              `Performance window lost visibility/focus: ${JSON.stringify({ visible: cadence.visible, focused: cadence.focused })}`
            );
          const frames = cadence.deltas;
          runs.push({
            pair,
            arm,
            mode,
            target,
            low,
            high,
            maxMounted,
            events: 96,
            frameP95Ms: quantile(frames, 0.95),
            frameP99Ms: quantile(frames, 0.99),
            frameMaxMs: Math.max(...frames),
            frameCount: frames.length,
            framesOver33Ms: frames.filter((v) => v > 33.5).length,
            framesOver50Ms: frames.filter((v) => v > 50).length,
            taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
            layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
            styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
            heapBefore,
            heapAfter,
            dom,
            longTasks: cadence.longTasks,
            frames,
          });
          console.log(
            `PROFILE ${pair} ${arm} ${mode}: task ${runs.at(-1).taskMs.toFixed(1)}ms p95 ${quantile(frames, 0.95).toFixed(2)}ms heap ${(heapAfter / 1048576).toFixed(1)}MiB`
          );
          fs.writeFileSync(
            path.join(configuration.output, "desktop-samples.json"),
            JSON.stringify(runs, null, 2)
          );
        }
        win.destroy();
        await pause(500);
      }
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
