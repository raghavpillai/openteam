const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.COMPOSER_PARITY_DIR, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 600,
    height: 400,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadURL(process.env.COMPOSER_PARITY_URL);
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await win.webContents.executeJavaScript("window.composerButtonResults");
      if (!result) continue;
      fs.writeFileSync(
        path.join(process.env.COMPOSER_PARITY_DIR, "results.json"),
        JSON.stringify(result)
      );
      app.quit();
      return;
    }
    throw Error("Composer button checks timed out");
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
