const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.setPath("userData", process.env.REACTION_TEST_PROFILE);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL(process.env.REACTION_TEST_URL);
    const result = await win.webContents.executeJavaScript("window.runReactionOrder()");
    fs.writeFileSync(process.env.REACTION_TEST_OUTPUT, JSON.stringify(result, null, 2));
    app.exit(result.passed === result.total ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(2);
  }
});
