const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require("electron");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.RESOURCE_LIFECYCLE_DIR;
const output = process.env.FOCUS_LIFECYCLE_OUTPUT;
const idleMs = Number(process.env.FOCUS_LIFECYCLE_DWELL_MS ?? 32_000);
const fullGrace = idleMs >= 31_000;
const caseFilter = new Set((process.env.FOCUS_LIFECYCLE_CASES ?? "").split(",").filter(Boolean));
const reports = [];
const cases = [];
const latency = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (data) => createHash("sha256").update(data).digest("hex");
app.setPath("userData", path.join(directory, "profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  let main;
  let cover;
  const check = (condition, message) => {
    if (!condition) throw Error(message);
    reports.push(message);
  };
  let lastProbe;
  try {
    const { bindWindowActivity, windowIsVisible, windowIsActive } = require(
      path.join(directory, "window-activity.cjs")
    );
    const work = screen.getPrimaryDisplay().workArea;
    const bounds = {
      x: work.x + 20,
      y: work.y + 20,
      width: Math.min(900, work.width - 280),
      height: Math.min(760, work.height - 60),
    };
    main = new BrowserWindow({
      ...bounds,
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(directory, "preload.cjs"),
      },
    });
    const dispose = bindWindowActivity(main);
    main.once("closed", dispose);
    cover = new BrowserWindow({ show: false, width: 220, height: 150 });
    await cover.loadURL("data:text/html,<title>OpenTeam focus test cover</title><p>Focus test</p>");
    ipcMain.handle("openteam:window-visibility", () => windowIsVisible(main));
    ipcMain.handle("openteam:window-activity", () => windowIsActive(main));
    ipcMain.handle("openteam:delivery-journal:read", () => null);
    ipcMain.handle("openteam:delivery-journal:write", () => {});
    const evaluate = (source) => main.webContents.executeJavaScript(source);
    const probe = async () => {
      const value = await evaluate("window.resourceProbe?.()");
      lastProbe = value;
      return value;
    };
    const waitFor = async (predicate) => {
      for (let index = 0; index < 400; index++) {
        const value = await probe();
        if (value && predicate(value)) return value;
        await pause(25);
      }
      throw Error("Focus state timed out " + JSON.stringify(lastProbe));
    };
    const focus = async () => {
      cover.hide();
      if (main.isMinimized()) main.restore();
      main.setBounds(bounds);
      app.focus({ steal: true });
      main.show();
      main.focus();
      await waitFor((value) => value.active && value.visible);
    };
    const setCover = async (kind) => {
      const target =
        kind === "full"
          ? bounds
          : kind === "partial"
            ? {
                x: bounds.x + bounds.width - 120,
                y: bounds.y + bounds.height - 120,
                width: 220,
                height: 150,
              }
            : { x: bounds.x + bounds.width + 10, y: bounds.y + 30, width: 220, height: 150 };
      cover.setBounds(target);
      cover.show();
      cover.focus();
      await waitFor((value) => !value.active && value.visible);
    };
    const sourceFor = (index) =>
      Array.from(
        { length: 1200 },
        (_, line) =>
          `const value_${index}_${line}: number = ${line}; // visible code remains readable`
      ).join("\n");
    const codeState = () =>
      evaluate(`(() => {
      const code = document.querySelector('[data-large-code]');
      const body = code?.closest('[data-streamdown="code-block-body"]');
      return { text: code?.textContent, html: code?.innerHTML, sameNode: code === window.focusCodeNode,
        highlighted: code?.dataset.highlighted === 'true', selection: getSelection()?.toString(),
        scrollTop: body?.scrollTop, scrollLeft: body?.scrollLeft,
        rangeText: [...CSS.highlights.values()].flatMap(group => [...group].map(range => range.toString())).join('|'),
        imagesLoaded: [...document.querySelectorAll('[data-resource]')].every(image => image.naturalWidth > 0) };
    })()`);
    const showCode = async (source) => {
      await evaluate(`window.renderResourceMarkdown(${JSON.stringify(source)})`);
      await waitFor((value) => value.stats.pendingHighlights === 0 && value.stats.tokenEntries > 0);
      for (let index = 0; index < 400; index++) {
        const value = await codeState();
        if (value.highlighted && value.text === source) break;
        if (index === 399) throw Error("Code did not render fully");
        await pause(25);
      }
      await evaluate(`(() => {
        const code = document.querySelector('[data-large-code]');
        const body = code.closest('[data-streamdown="code-block-body"]');
        body.style.maxHeight = '240px'; body.style.overflow = 'auto';
        body.scrollTop = 140; body.scrollLeft = 0;
        const range = document.createRange(); range.selectNodeContents(code);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        window.focusCodeNode = code;
      })()`);
      await pause(150);
    };
    const capture = async (name) => {
      const rect = await evaluate(`(() => {
        const r = document.querySelector('[data-streamdown="code-block-body"]').getBoundingClientRect();
        return {x:Math.ceil(r.x)+3,y:Math.ceil(r.y)+3,width:Math.min(700,Math.floor(r.width)-100),height:Math.min(180,Math.floor(r.height)-20)};
      })()`);
      const image = await main.webContents.capturePage(rect, { stayHidden: true });
      check(!image.isEmpty(), name + " code screenshot is available");
      fs.writeFileSync(path.join(output, name + ".png"), image.toPNG());
      return hash(image.toBitmap());
    };
    await main.loadURL(process.env.RESOURCE_LIFECYCLE_URL);
    await focus();
    await evaluate(
      `Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.focusCopiedText=text}}})`
    );
    const modes = [
      { name: "focused-idle", active: true, visible: true, enter: focus },
      {
        name: "unfocused-uncovered",
        minimumIdleMs: 65_000,
        active: false,
        visible: true,
        enter: () => setCover("outside"),
      },
      { name: "partially-covered", active: false, visible: true, enter: () => setCover("partial") },
      { name: "fully-covered", active: false, visible: true, enter: () => setCover("full") },
      {
        name: "another-app-active",
        active: false,
        visible: true,
        enter: async () => {
          cover.hide();
          const activated = execFileSync(
            "/usr/bin/osascript",
            [
              "-l",
              "JavaScript",
              "-e",
              'ObjC.import("AppKit"); var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.finder"); if(apps.count===0) throw Error("Finder is unavailable"); apps.objectAtIndex(0).activateWithOptions($.NSApplicationActivateIgnoringOtherApps);',
            ],
            { encoding: "utf8" }
          );
          check(activated.trim() === "true", "Finder activates through the native application API");
          await waitFor((value) => !value.active && value.visible);
        },
      },
      {
        name: "hidden",
        minimumIdleMs: 65_000,
        active: false,
        visible: false,
        enter: async () => {
          main.hide();
          await waitFor((value) => !value.visible);
        },
      },
      {
        name: "minimized",
        active: false,
        visible: false,
        enter: async () => {
          main.minimize();
          await waitFor((value) => !value.visible);
        },
      },
      {
        name: "shown-without-focus",
        active: false,
        visible: true,
        enter: async () => {
          await setCover("outside");
          main.hide();
          await waitFor((value) => !value.visible);
          main.showInactive();
          await waitFor((value) => !value.active && value.visible);
        },
      },
    ];
    let scenario = 0;
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await evaluate(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.classList.toggle('dark',${theme === "dark"})`
      );
      for (const mode of theme === "light"
        ? modes
        : modes.filter((mode) => mode.name === "partially-covered")) {
        if (caseFilter.size > 0 && !caseFilter.has(mode.name)) continue;
        scenario++;
        const name = theme + "-" + mode.name;
        const caseIdleMs = fullGrace ? Math.max(idleMs, mode.minimumIdleMs ?? 0) : idleMs;
        console.log("Native focus scenario", name, "idle", caseIdleMs);
        await focus();
        const source = sourceFor(scenario);
        await showCode(source);
        const count = (await probe()).highlightDone;
        await evaluate(
          `window.highlightResourceCode(${JSON.stringify("const warm_" + scenario + " = true;")}, 'typescript')`
        );
        await waitFor((value) => value.highlightDone === count + 1 && value.workers === 1);
        await mode.enter();
        await waitFor((value) => value.active === mode.active && value.visible === mode.visible);
        await pause(250);
        const before = await codeState();
        const images = (await probe()).sources;
        check(before.imagesLoaded, name + " displays decoded images before idle");
        if (mode.name === "partially-covered") {
          const a = main.getBounds(),
            b = cover.getBounds();
          const intersection =
            Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
            Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
          check(
            intersection > 0 && intersection < a.width * a.height,
            name + " uses a genuinely partial native-window overlap"
          );
        }
        const beforePixels = mode.visible ? await capture(name + "-before") : null;
        await pause(caseIdleMs);
        const expectedWorkers = mode.active || !fullGrace ? 1 : 0;
        const after = await waitFor((value) => value.workers === expectedWorkers);
        const code = await codeState();
        check(
          code.text === source && code.html === before.html && code.sameNode,
          name + " preserves full code text, markup and DOM identity"
        );
        check(
          code.selection === before.selection &&
            code.scrollTop === before.scrollTop &&
            code.scrollLeft === before.scrollLeft,
          name + " preserves selection and reading position"
        );
        check(
          code.rangeText === before.rangeText && code.highlighted,
          name + " retains syntax highlighting after idle"
        );
        if (mode.visible) {
          check(
            JSON.stringify(after.sources) === JSON.stringify(images) && code.imagesLoaded,
            name + " keeps visible images pinned"
          );
          check(
            (await capture(name + "-after")) === beforePixels,
            name + " code pixels remain identical across idle"
          );
        } else if (fullGrace) {
          check(
            after.sources.every((source) => source === null),
            name + " parks optional image consumers after the grace period"
          );
        }
        for (let index = 0; index < 160; index++) {
          if (
            await evaluate(
              `!document.querySelector('[data-streamdown="code-block"]').querySelector('button').disabled`
            )
          )
            break;
          if (index === 159) throw Error(name + " copy button stayed disabled");
          await pause(25);
        }
        await evaluate(
          `window.focusCopiedText=null; document.querySelector('[data-streamdown="code-block"]').querySelector('button').click()`
        );
        check(
          await evaluate(`window.focusCopiedText === ${JSON.stringify(source + "\n")}`),
          name + " copies the complete code after idle"
        );
        await evaluate(
          `document.querySelector('[data-streamdown="code-block-body"]').scrollTop=2000`
        );
        await pause(150);
        const scrolled = await codeState();
        check(
          scrolled.text === source &&
            scrolled.rangeText.length > 0 &&
            scrolled.rangeText !== code.rangeText,
          name + " repaints syntax ranges when scrolled after idle"
        );
        const nextSource = source + "\nconst incoming = " + scenario + ";";
        if (expectedWorkers === 0 && mode.visible) {
          await focus();
          check(
            (await probe()).workers === 0,
            name + " focus alone keeps the retired worker released"
          );
          await mode.enter();
        }
        const started = Date.now();
        await showCode(nextSource);
        const readyMs = Date.now() - started - 150;
        latency.push({ name, readyMs, retired: expectedWorkers === 0 });
        check(
          (await probe()).workers === 1 && (await codeState()).text === nextSource,
          name + " highlights newly arriving code through a live worker"
        );
        cases.push({
          name,
          idleMs: caseIdleMs,
          active: after.active,
          visible: after.visible,
          workersAfterIdle: after.workers,
          readyMs,
          bounds: main.getBounds(),
        });
      }
    }
    await focus();
    await showCode(sourceFor(++scenario));
    const creations = (await probe()).workerCreations;
    for (let index = 0; index < 100; index++) {
      await setCover("partial");
      await focus();
    }
    check(
      (await probe()).workerCreations === creations,
      "100 rapid native focus switches keep the warm worker"
    );
    check(
      (await codeState()).text === sourceFor(scenario),
      "100 native focus switches preserve rendered code"
    );
    for (let index = 0; index < 25; index++) {
      await modes.find((mode) => mode.name === "another-app-active").enter();
      await focus();
    }
    check(
      (await probe()).workerCreations === creations,
      "25 native switches to Finder and back keep the warm worker"
    );
    check(
      (await codeState()).selection === sourceFor(scenario),
      "native app switching preserves the complete code selection"
    );
    if (fullGrace) {
      console.log("Native focus scenario pending-response across idle deadline");
      await setCover("partial");
      await pause(27_000);
      const pendingSource = sourceFor(++scenario);
      await evaluate("window.holdHighlightResponses(true)");
      await evaluate(`window.renderResourceMarkdown(${JSON.stringify(pendingSource)})`);
      await waitFor((value) => value.heldMessages > 0 && value.stats.pendingHighlights > 0);
      await pause(6_000);
      check(
        (await probe()).workers === 1 && (await probe()).stats.pendingHighlights > 0,
        "a new request at the idle boundary survives the old retirement deadline"
      );
      check(
        (await codeState()).text === pendingSource,
        "code remains fully readable while highlighting is pending"
      );
      await focus();
      await evaluate("window.holdHighlightResponses(false)");
      await waitFor((value) => value.stats.pendingHighlights === 0);
      check(
        (await probe()).errors.length === 0,
        "foreground return completes the pending request without errors"
      );
    }
    await focus();
    await evaluate("window.renderResourceChat()");
    await waitFor((value) => value.draft !== null);
    await evaluate(
      `window.focusEditor=document.querySelector('[contenteditable="true"][role="textbox"]'); window.focusEditor.focus()`
    );
    await main.webContents.insertText("Native focus draft survives idle");
    await waitFor((value) => value.draft.includes("Native focus draft survives idle"));
    await evaluate(
      `(() => {const node=document.createTreeWalker(window.focusEditor,NodeFilter.SHOW_TEXT).nextNode(); const range=document.createRange();range.setStart(node,2);range.setEnd(node,8);getSelection().removeAllRanges();getSelection().addRange(range)})()`
    );
    await setCover("partial");
    await pause(idleMs);
    await focus();
    check(
      (await probe()).draft.includes("Native focus draft survives idle"),
      "the real composer preserves its draft across prolonged native focus loss"
    );
    check(
      await evaluate(
        "document.activeElement===window.focusEditor && getSelection().anchorOffset===2 && getSelection().focusOffset===8"
      ),
      "the real composer restores focus and caret selection after native app switching"
    );
    await evaluate("window.disposeResources()");
    const final = await probe();
    check(
      final.errors.length === 0 && !final.highlightError,
      "all native focus scenarios finish without renderer errors"
    );
    const result = {
      passed: reports.length,
      fullGrace,
      idleMs,
      platform: process.platform,
      reports,
      cases,
      latency,
      final,
    };
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(result, null, 2));
    main.destroy();
    cover.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, "results.json"),
      JSON.stringify(
        { error: error.stack, fullGrace, reports, cases, latency, probe: lastProbe },
        null,
        2
      )
    );
    main?.destroy();
    cover?.destroy();
    app.exit(1);
  }
});
