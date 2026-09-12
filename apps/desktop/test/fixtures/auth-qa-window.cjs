// Run with Electron after starting the renderer and loopback auth fixture.
const { app, BrowserWindow, Menu } = require("electron");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

app.setPath("userData", mkdtempSync(join(tmpdir(), "openteam-auth-qa-")));
app.whenReady().then(() => {
  const window = new BrowserWindow({
    title: "OpenTeam Onboarding QA",
    width: 900,
    height: 740,
    minWidth: 320,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true },
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ])
  );
  const suffix = process.env.OPENTEAM_AUTH_QA_STORAGE_ERROR === "1" ? "?storage-error" : "";
  void window.loadURL(`http://127.0.0.1:5196/test/browser/auth-onboarding.html${suffix}`);
});
app.on("window-all-closed", () => app.quit());
