const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.DESKTOP_MEDIA_PROFILE);
app.commandLine.appendSwitch("remote-debugging-port", process.env.DESKTOP_MEDIA_PORT);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width: 1456,
    height: 924,
    useContentSize: true,
    title: "Desktop attachment checks",
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadURL(process.env.DESKTOP_MEDIA_URL);
});
app.on("window-all-closed", () => app.quit());
