const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.VNC_QA_PROFILE);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, webPreferences: { backgroundThrottling: false, preload: process.env.VNC_QA_PRELOAD } });
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("VNC_")) console.log(event.message);
    else if (event.level === "error") console.error("Viewer error:", event.message);
  });
  await win.loadURL(process.env.VNC_QA_URL);
});
app.on("window-all-closed", () => app.quit());
