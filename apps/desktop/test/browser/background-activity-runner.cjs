const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.BACKGROUND_ACTIVITY_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("BACKGROUND_ACTIVITY_RESULT ")) {
      fs.writeFileSync(
        path.join(process.env.BACKGROUND_ACTIVITY_DIR, "results.json"),
        event.message.slice("BACKGROUND_ACTIVITY_RESULT ".length)
      );
      app.quit();
    } else if (event.level === "error") console.error(event.message);
  });
  await win.loadURL(process.env.BACKGROUND_ACTIVITY_URL);
});
