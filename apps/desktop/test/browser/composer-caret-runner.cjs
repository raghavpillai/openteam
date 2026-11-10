const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const directory = process.env.COMPOSER_CARET_DIR;
app.setPath("userData", path.join(directory, "profile"));
app.commandLine.appendSwitch("enable-experimental-web-platform-features");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const origin = new URL(process.env.COMPOSER_CARET_URL).origin;
  const isolated = session.fromPartition("composer-caret-test");
  isolated.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url);
    callback({ cancel: url.origin !== origin || url.pathname.startsWith("/api") });
  });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 600,
    webPreferences: { session: isolated, backgroundThrottling: false },
  });
  const evaluate = (expression) => win.webContents.executeJavaScript(expression);
  const reports = [];
  const key = (keyCode) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  async function click(selector) {
    const point = await evaluate(`(() => {
      const scale = ${win.webContents.getZoomFactor()};
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: (rect.x + rect.width / 2) * scale,
        y: (rect.y + rect.height / 2) * scale };
    })()`);
    for (const type of ["mouseDown", "mouseUp"])
      win.webContents.sendInputEvent({
        type,
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: "left",
        clickCount: 1,
      });
    await wait(30);
  }
  async function paste() {
    await evaluate(`(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "line one\\nline two");
      document.querySelector('[role="textbox"]').dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
    })()`);
    await wait(350);
    assert(
      await evaluate(`!!document.querySelector('[role="textbox"] > div')`),
      "Paste must exercise Chromium's block markup"
    );
  }
  async function caret(theme, name) {
    await wait(350);
    const metrics = await evaluate(`(() => {
      const scale = ${win.webContents.getZoomFactor()};
      const editor = document.querySelector('[role="textbox"]');
      const rect = editor.getBoundingClientRect();
      const style = getComputedStyle(editor);
      return { empty: editor.innerHTML === "", focused: document.activeElement === editor,
        x: (rect.x + parseFloat(style.paddingLeft)) * scale,
        y: (rect.y + parseFloat(style.paddingTop)) * scale,
        lineHeight: parseFloat(style.lineHeight) * scale };
    })()`);
    assert(metrics.empty && metrics.focused, `${name}: editor must be empty and focused`);
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(directory, `${theme}-${name}.png`), screenshot.toPNG());
    const pixels = screenshot.toBitmap({ scaleFactor: 1 });
    const { width, height } = screenshot.getSize(1);
    const rows = [];
    // Read the real native caret. An empty contenteditable's DOM Range has a zero rect.
    for (
      let y = Math.max(0, Math.floor(metrics.y));
      y < Math.min(height, Math.ceil(metrics.y + metrics.lineHeight));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(metrics.x) - 1);
        x <= Math.min(width - 1, Math.ceil(metrics.x));
        x++
      ) {
        const pixel = (y * width + x) * 4;
        const rgb = [pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]];
        if (theme === "light" ? Math.max(...rgb) < 90 : Math.min(...rgb) > 210) rows.push(y);
      }
    }
    assert(rows.length > 0, `${name}: native caret is missing from screenshot`);
    return { top: Math.min(...rows) - metrics.y, bottom: Math.max(...rows) - metrics.y };
  }
  try {
    for (const theme of ["light", "dark"]) {
      await win.loadURL(`${process.env.COMPOSER_CARET_URL}?manual&theme=${theme}`);
      win.webContents.setZoomFactor(2);
      await wait(150);
      await evaluate(`(() => {
        const main = document.querySelector("main");
        main.style.width = "600px";
        document.querySelector('[role="textbox"]').dataset.placeholder = "Message Chief of Staff";
        const style = document.createElement("style");
        style.textContent = '[contenteditable] { caret-animation: manual !important; }';
        document.head.append(style);
      })()`);
      win.focus();
      win.webContents.focus();
      await click('[role="textbox"]');
      const fresh = await caret(theme, "fresh");
      async function unchanged(name) {
        const actual = await caret(theme, name);
        assert.deepEqual(actual, fresh, `${theme}/${name}: empty caret shifted vertically`);
        reports.push(`${theme}: ${name}`);
      }
      for (const action of ["Enter", "button", "Backspace"]) {
        await paste();
        if (action === "button") await click('[aria-label="Send message"]');
        else if (action === "Backspace") {
          win.webContents.selectAll();
          await wait(30);
          key("Backspace");
        } else key("Return");
        await unchanged(`paste-${action}`);
        await evaluate(`document.querySelector('[role="textbox"]').blur()`);
        await click('[role="textbox"]');
        await unchanged(`refocus-${action}`);
        key("Backspace");
        await unchanged(`empty-backspace-${action}`);
      }
      await win.webContents.insertText("x");
      key("Backspace");
      await unchanged("type-delete");
    }
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ reports }));
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
