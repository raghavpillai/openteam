const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
if (configuration.reduced) app.commandLine.appendSwitch("force-prefers-reduced-motion");
app.setPath("userData", path.join(__dirname, "profile"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1050,
      height: 850,
      webPreferences: { backgroundThrottling: false },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const sample = () => js("window.scrollHarness.sample()");
    const reports = [];
    const evidence = [];
    let name = "startup";
    const suffix = configuration.reduced ? "reduced" : "normal";
    try {
      await win.loadURL(configuration.url);
      assert(
        (await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`)) ===
          configuration.reduced,
        "Motion preference mismatch"
      );
      async function stable() {
        await pause(200);
        const before = await sample();
        assert(before?.ready, "Transcript not ready");
        assert(before.rows.length, "Blank transcript");
        assert(before.mounted <= 80, "Unbounded mounted rows");
        for (let i = 0; i < 3; i++) {
          await pause(80);
          const next = await sample();
          assert(
            JSON.stringify(next.rows.map((r) => r.id)) ===
              JSON.stringify(before.rows.map((r) => r.id)),
            `Idle row change ${JSON.stringify({ before, next })}`
          );
          next.rows.forEach((row, index) => {
            assert(
              Math.abs(row.y - before.rows[index].y) <= 1,
              `Idle jump ${JSON.stringify({ before, next })}`
            );
            if (index)
              assert(
                row.y >= next.rows[index - 1].y + next.rows[index - 1].height - 1,
                "Overlapping rows"
              );
          });
        }
        return before;
      }
      async function wheel(older, count, delta, interval) {
        const position = await sample();
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(position.x),
          y: Math.round(position.y),
        });
        for (let i = 0; i < count; i++) {
          win.webContents.sendInputEvent({
            type: "mouseWheel",
            x: Math.round(position.x),
            y: Math.round(position.y),
            deltaY: older ? delta : -delta,
            deltaX: 0,
            canScroll: true,
          });
          await pause(interval);
        }
      }
      for (const mode of configuration.focusOnly
        ? []
        : configuration.mode
          ? [configuration.mode]
          : ["text", "rich", "media", "search", "thread"])
        for (const overlay of mode === "thread" ? [false] : [false, true]) {
          name = mode + "-" + (overlay ? "overlay" : "native");
          await js(`window.scrollHarness.mount(${JSON.stringify(mode)},${overlay})`);
          for (let i = 0; i < 300; i++) {
            if ((await sample())?.ready) break;
            await pause(20);
          }
          let previous = await stable();
          if (mode === "thread")
            assert(
              previous.rows.some((row) => row.id === 175),
              "Thread search target was dropped"
            );
          const startingMediaDownloads = previous.mediaDownloads;
          let low = previous.rows.find((row) => mode !== "thread" || row.id !== 0).id;
          let high = previous.rows.at(-1).id;
          await js("window.scrollHarness.start()");
          for (const [older, count, delta, interval] of [
            [true, 45, 260, 18],
            [true, 40, 22, 24],
            [false, mode === "search" || mode === "thread" ? 80 : 30, 260, 18],
            [true, 20, 90, 18],
            [false, 20, 90, 18],
            [true, 30, 260, 18],
            [false, 30, 260, 18],
          ]) {
            await js(`window.scrollHarness.phase(${JSON.stringify(older ? "older" : "newer")})`);
            await wheel(older, count, delta, interval);
            let after = await stable();
            assert(
              older
                ? after.rows[0].id <= previous.rows[0].id
                : after.rows[0].id >= previous.rows[0].id,
              `Scroll moved in the wrong direction: ${JSON.stringify({ older, before: previous, after })}`
            );
            low = Math.min(low, after.rows.find((row) => mode !== "thread" || row.id !== 0).id);
            high = Math.max(high, after.rows.at(-1).id);
            previous = after;
          }
          // Reverse direction before the wheel sequence has had time to settle.
          await js("window.scrollHarness.phase('rapid-reversals')");
          for (let reverse = 0; reverse < 8; reverse++) await wheel(reverse % 2 === 0, 5, 100, 12);
          await stable();
          const frames = await js("window.scrollHarness.stop()");
          assert(high - low >= 40, `Not enough history traversed: ${low}..${high}`);
          let blanks = 0,
            maxBlanks = 0;
          for (const frame of frames) {
            blanks = frame.rows?.length ? 0 : blanks + 1;
            maxBlanks = Math.max(maxBlanks, blanks);
            assert(frame.mounted <= 80, "Unbounded rows during scrolling");
            for (let i = 1; i < (frame.rows?.length ?? 0); i++) {
              const previous = frame.rows[i - 1],
                row = frame.rows[i];
              assert(row.index === previous.index + 1, "Missing or reordered virtual rows");
              assert(
                row.y >= previous.y + previous.height - 1,
                `Overlap during scrolling: ${JSON.stringify({ previous, row, phase: frame.phase })}`
              );
            }
          }
          assert(maxBlanks <= 2, `Blank transcript persisted ${maxBlanks} frames`);
          if (mode === "search")
            assert(
              low < 460 && high > 540,
              `Search did not cross both context edges: ${low}..${high}`
            );
          if (mode === "media")
            assert(
              (await sample()).mediaDownloads > startingMediaDownloads,
              "Media scrolling did not finish additional image downloads"
            );
          const refocused = [];
          if (mode === "thread") {
            for (const target of [25, 325, 175]) {
              await js(`window.scrollHarness.focus(${target})`);
              await pause(40);
              for (let attempt = 0; attempt < 300; attempt++) {
                if ((await sample())?.ready) break;
                await pause(20);
              }
              const next = await stable();
              assert(
                next.rows.some((row) => row.id === target),
                `Thread did not refocus ${target}`
              );
              refocused.push({ target, ...next });
            }
          }
          evidence.push({ name, low, high, maxBlanks, frames, refocused });
          reports.push(name);
          console.log("PASS " + name + " (" + low + ".." + high + ")");
        }
      name = "immediate-scroll-after-search";
      await js("window.scrollHarness.mount('text',false)");
      for (let i = 0; i < 300; i++) {
        if ((await sample())?.ready) break;
        await pause(20);
      }
      const initial = await stable();
      await js(`window.scrollHarness.focus(${initial.rows[0].id})`);
      await stable();
      // Refocus the already measured result, then immediately use the wheel.
      await js(`window.scrollHarness.focus(${initial.rows[0].id})`);
      await pause(25);
      await js("window.scrollHarness.phase('older')");
      await js("window.scrollHarness.start()");
      await wheel(true, 12, 40, 16);
      await stable();
      const immediate = await js("window.scrollHarness.stop()");
      for (let i = 1; i < immediate.length; i++) {
        const a = immediate[i - 1],
          b = immediate[i];
        for (const row of b.rows) {
          const old = a.rows.find((r) => r.id === row.id);
          if (old)
            assert(row.y >= old.y - 1, `Search pulled scrolling backward by ${old.y - row.y}px`);
        }
      }
      evidence.push({ name, frames: immediate });
      reports.push(name);
      console.log("PASS " + name);
      name = "momentum-while-page-pending";
      await js("window.scrollHarness.mount('search',false)");
      for (let i = 0; i < 300; i++) {
        if ((await sample())?.ready) break;
        await pause(20);
      }
      await stable();
      await js("window.scrollHarness.focus(550)");
      await stable();
      await js("window.scrollHarness.pageDelay(1200)");
      await js("window.scrollHarness.phase('newer')");
      await js("window.scrollHarness.start()");
      await wheel(false, 1, 700, 16);
      await pause(800);
      const pending = await js("window.scrollHarness.stop()");
      assert(
        pending.some((frame) => frame.page.loading),
        "Wheel did not trigger pagination"
      );
      for (let i = 1; i < pending.length; i++) {
        const a = pending[i - 1],
          b = pending[i];
        if (a.page.start !== b.page.start) continue;
        for (const row of b.rows) {
          const old = a.rows.find((r) => r.id === row.id);
          if (old)
            assert(
              row.y <= old.y + 1,
              `Pending page pulled momentum backward by ${row.y - old.y}px`
            );
        }
      }
      await pause(600);
      await stable();
      evidence.push({ name, frames: pending });
      reports.push(name);
      console.log("PASS " + name);
      fs.writeFileSync(
        path.join(configuration.output, "desktop-" + suffix + ".json"),
        JSON.stringify({ reports, evidence }, null, 2)
      );
      app.quit();
    } catch (error) {
      fs.writeFileSync(
        path.join(configuration.output, "desktop-" + suffix + ".json"),
        JSON.stringify(
          {
            reports,
            evidence,
            name,
            error: String(error),
            last: await sample(),
            frames: await js("window.scrollHarness.stop()"),
          },
          null,
          2
        )
      );
      const capture = await win.webContents.capturePage();
      fs.writeFileSync(
        path.join(configuration.output, "desktop-" + suffix + "-failure.png"),
        capture.toPNG()
      );
      console.error(name + ": " + error);
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
