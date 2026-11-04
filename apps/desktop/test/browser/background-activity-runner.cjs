const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.BACKGROUND_ACTIVITY_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: process.env.BACKGROUND_ACTIVITY_SHOW === "1",
    width: 900,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on("console-message", async (event) => {
    if (event.message.startsWith("BACKGROUND_ACTIVITY_RESULT ")) {
      fs.writeFileSync(
        path.join(process.env.BACKGROUND_ACTIVITY_DIR, "results.json"),
        event.message.slice("BACKGROUND_ACTIVITY_RESULT ".length)
      );
      if (process.env.BACKGROUND_ACTIVITY_SCREENSHOT) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        fs.writeFileSync(process.env.BACKGROUND_ACTIVITY_SCREENSHOT,
          (await win.webContents.capturePage()).toPNG());
      }
      app.quit();
    } else if (event.level === "error") console.error(event.message);
  });
  await win.loadURL(process.env.BACKGROUND_ACTIVITY_URL);
});
