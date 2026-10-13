const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.TAILSCALE_QA_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 880,
    height: 820,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadURL(process.env.TAILSCALE_QA_URL);
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await win.webContents.executeJavaScript("window.tailscaleSettingsResults");
      if (!result) continue;
      fs.writeFileSync(
        path.join(process.env.TAILSCALE_QA_DIR, "results.json"),
        JSON.stringify(result)
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      fs.writeFileSync(
        path.join(process.env.TAILSCALE_QA_DIR, "settings.png"),
        (await win.webContents.capturePage()).toPNG()
      );
      app.quit();
      return;
    }
    throw new Error("Tailscale settings tests timed out");
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
