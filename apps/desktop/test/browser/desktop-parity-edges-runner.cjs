const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.DESKTOP_PARITY_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 985,
    height: 960,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("DESKTOP_PARITY_RESULT ")) {
      fs.writeFileSync(
        path.join(process.env.DESKTOP_PARITY_DIR, "results.json"),
        event.message.slice("DESKTOP_PARITY_RESULT ".length)
      );
      app.quit();
    } else if (event.level === "error") console.error(event.message);
  });
  await win.loadURL(process.env.DESKTOP_PARITY_URL);
});
