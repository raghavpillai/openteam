const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
app.setPath("userData", process.env.SERVER_ACTIVITY_PROFILE);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    title: "OpenTeam · Server activity QA",
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(process.env.SERVER_ACTIVITY_PROFILE, "preload.cjs"),
    },
  });
  const visible = () => window.isVisible() && !window.isMinimized();
  ipcMain.handle("openteam:window-visibility", visible);
  ipcMain.handle("openteam:tailscale", () => ({ canManage: false, status: null }));
  const publish = () => window.webContents.send("openteam:window-visibility-changed", visible());
  for (const event of ["show", "hide", "minimize", "restore"]) window.on(event, publish);
  window.webContents.on("did-finish-load", publish);
  window.loadURL("about:blank");
});
