const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.BOT_ACTIONS_TEST_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { backgroundThrottling: false } });
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
  const until = async (fn) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await run(fn)) return; await wait(); }
    throw new Error("GUI did not reach its expected state");
  };
  const reports = [];
  const capture = async (suffix) => fs.writeFileSync(
    process.env.BOT_ACTIONS_TEST_SCREENSHOT.replace(".png", `-${suffix}.png`),
    (await win.webContents.capturePage()).toPNG());
  try {
    for (const theme of ["light", "dark"]) {
      await win.loadURL(process.env.BOT_ACTIONS_TEST_URL + "?count=6&read=1");
      await until(() => !!document.querySelector('[data-channel-id="channel-0"] button'));
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      for (const channelId of ["channel-0", "channel-1"]) {
        const point = await win.webContents.executeJavaScript(`(() => {
          const rect = document.querySelector('[data-channel-id="${channelId}"] button').getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
        win.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
        await until(() => !!document.querySelector('[role="menuitem"]'));
        const actions = await run(() => {
          const actions = Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent.trim());
          if (!actions.includes("Delete") || !actions.includes("Edit Profile")) throw new Error("Edit and Delete must remain available");
          if (actions.some((action) => /hide|duplicate/i.test(action))) throw new Error("Hide or Duplicate remains in a conversation menu");
          return actions;
        });
        reports.push({ theme, channelId, actions });
        await capture(`${theme}-${channelId}-menu`);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until(() => !document.querySelector('[role="menuitem"]'));
      }
      await run(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true })));
      await until(() => !!document.querySelector('[data-compact-channel-id="channel-0"]'));
      await run(() => {
        if (/Hidden Bots|Show Hidden Bots/.test(document.body.textContent)) throw new Error("The hidden bots manager remains in the compact sidebar");
      });
      await capture(`${theme}-compact`);
      await run(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true })));
      await until(() => !!document.querySelector('[data-channel-id="channel-0"] button'));
      await win.loadURL(process.env.BOT_ACTIONS_TEST_URL + "?count=6&read=1&settings=1");
      await until(() => !!document.querySelector('aside[aria-label="Settings"]'));
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      reports.push(await run(() => {
        const buttons = Array.from(document.querySelectorAll("button"), (button) => button.textContent.trim());
        if (!buttons.includes("Delete bot") || !buttons.includes("Share as template")) throw new Error("Bot settings did not render its remaining actions");
        if (buttons.some((label) => /Duplicate bot|Hide from sidebar/.test(label))) throw new Error("A removed action remains in Bot settings");
        return { settingsActions: buttons.filter((label) => /Delete bot|Share as template/.test(label)) };
      }));
      await capture(`${theme}-settings`);
    }
    fs.writeFileSync(process.env.BOT_ACTIONS_TEST_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(process.env.BOT_ACTIONS_TEST_DIR, "results.json"), JSON.stringify({ reports }));
  } catch (error) {
    await capture("failure");
    fs.writeFileSync(path.join(process.env.BOT_ACTIONS_TEST_DIR, "results.json"), JSON.stringify({ error: error.message }));
  }
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
