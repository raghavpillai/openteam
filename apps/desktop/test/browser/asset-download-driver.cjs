const { app, BrowserWindow, dialog } = require("electron");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const directory = process.env.ASSET_DOWNLOAD_DIR;
const settings = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
const profile = path.join(directory, "profile");
const downloads = path.join(directory, "downloads");
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(path.join(profile, "auth-session.json"), JSON.stringify({ version: 1, token: settings.token }));
app.setPath("userData", profile);
let pickerCalls = 0;
let pickerAction = "save";
const warnings = [];
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("Timed out waiting for native download result");
};
dialog.showOpenDialog = async window => {
  pickerCalls++;
  if (pickerAction === "switch") {
    await window.webContents.executeJavaScript(`window.openteam.auth.connectMachine(${JSON.stringify(settings.otherServer)})`);
  }
  return { canceled: pickerAction === "cancel", filePaths: pickerAction === "cancel" ? [] : [downloads] };
};
dialog.showMessageBox = async (_window, options) => {
  warnings.push(options);
  return { response: 0 };
};

const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function () {
  return loadFile.call(this, settings.renderer, {
    query: { server: settings.server, asset: settings.asset, bytes: String(settings.bytes) },
  });
};
app.on("browser-window-created", (_event, window) => {
  window.show = () => {};
  window.webContents.once("did-finish-load", async () => {
    const js = source => window.webContents.executeJavaScript(source);
    const files = [{ fileName: "shipping-label.PDF", url: `${settings.server}/api/v0/assets/${settings.asset}?name=shipping-label.PDF&download=1` }];
    const invoke = () => js(`window.openteam.files.downloadAll(${JSON.stringify(files)})`);
    try {
      await until(() => js('!!document.querySelector("canvas") && !!document.querySelector(\'button[aria-label="Download file"]\')'));
      assert.ok(window.webContents.getURL().startsWith("file://"));
      // Exercise the real preview button and production renderer helper first.
      await js('document.querySelector(\'button[aria-label="Download file"]\').click()');
      if (settings.baseline) {
        await until(() => js('document.body.textContent.includes("Download request is invalid")'));
        assert.equal(pickerCalls, 0);
        assert.deepEqual(fs.readdirSync(downloads), []);
        checks.push("baseline: preview loads but download is rejected before the picker");
      } else {
        const saved = path.join(downloads, "shipping-label.PDF");
        await until(() => fs.existsSync(saved) && fs.statSync(saved).size === settings.bytes);
        assert.equal(createHash("sha256").update(fs.readFileSync(saved)).digest("hex"), settings.asset);
        assert.equal(pickerCalls, 1);
        checks.push("preview button saves the exact source PDF through native IPC and net.fetch");
        assert.equal((await invoke()).saved, 1);
        assert.deepEqual(fs.readFileSync(path.join(downloads, "shipping-label-2.PDF")), fs.readFileSync(saved));
        checks.push("repeat download chooses a unique filename without overwriting");
        pickerAction = "cancel";
        assert.equal((await invoke()).canceled, true);
        assert.equal(fs.readdirSync(downloads).length, 2);
        checks.push("folder-picker cancellation writes no file");
        pickerAction = "save";
        for (const url of [
          `${settings.otherServer}/api/v0/assets/${settings.asset}`,
          `${settings.server}/api/v0/auth/session`,
        ]) {
          await assert.rejects(js(`window.openteam.files.downloadAll(${JSON.stringify([{ fileName: "bad.pdf", url }])})`), /Download request is invalid/);
        }
        checks.push("foreign origins and non-asset routes are rejected by the actual handler");
        for (const mode of ["unauthorized", "redirect"]) {
          await fetch(`${settings.server}/fixture-mode/${mode}`, { method: "POST" });
          assert.equal((await invoke()).saved, 0);
          assert.equal(fs.readdirSync(downloads).length, 2);
        }
        assert.equal(warnings.length, 2);
        checks.push("401 and redirect failures remove partial files and show native warnings");
        await fetch(`${settings.server}/fixture-mode/success`, { method: "POST" });
        pickerAction = "switch";
        await assert.rejects(invoke(), /server changed/);
        assert.equal(fs.readdirSync(downloads).length, 2);
        checks.push("changing servers while choosing a folder aborts the download");
        await js("window.openteam.auth.clearToken()");
        await assert.rejects(invoke(), /Download request is invalid/);
        checks.push("sign-out removes the trusted download server");
      }
      fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ checks, pickerCalls }));
    } catch (error) {
      fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify({ checks, error: error.stack }));
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
});
import(pathToFileURL(path.join(directory, "dist-electron/main.js")).href).catch(error => {
  console.error(error);
  app.exit(1);
});
