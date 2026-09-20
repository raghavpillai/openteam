const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.MESSAGE_MOTION_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 920,
    height: 740,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("MESSAGE_MOTION_RESULT ")) {
      fs.writeFileSync(
        path.join(process.env.MESSAGE_MOTION_DIR, "results.json"),
        event.message.slice("MESSAGE_MOTION_RESULT ".length)
      );
      app.quit();
    } else if (event.level === "error") console.error(event.message);
  });
  await win.loadURL(process.env.MESSAGE_MOTION_URL);
});
