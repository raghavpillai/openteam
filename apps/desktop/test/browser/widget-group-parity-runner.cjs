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
  win.webContents.on("console-message", async (event) => {
    if (event.message.startsWith("WIDGET_MOTION ")) {
      try {
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
        await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: event.message.slice("WIDGET_MOTION ".length) }],
        });
        await win.webContents.executeJavaScript('window.dispatchEvent(new Event("widget-motion-ready"))');
      } catch (error) {
        fs.writeFileSync(path.join(process.env.DESKTOP_PARITY_DIR, "results.json"), JSON.stringify({ error: String(error) }));
        app.quit();
      }
      return;
    }
    if (event.message.startsWith("WIDGET_CAPTURE ") && process.env.WIDGET_PARITY_OUTPUT) {
      const name = event.message.slice("WIDGET_CAPTURE ".length);
      win.webContents
        .capturePage()
        .then((image) =>
          fs.writeFileSync(
            path.join(process.env.WIDGET_PARITY_OUTPUT, name + ".png"),
            image.toPNG()
          )
        );
    } else if (event.message.startsWith("DESKTOP_PARITY_RESULT ")) {
      fs.writeFileSync(
        path.join(process.env.DESKTOP_PARITY_DIR, "results.json"),
        event.message.slice("DESKTOP_PARITY_RESULT ".length)
      );
      app.quit();
    } else if (event.level === "error") console.error(event.message);
  });
  await win.loadURL(process.env.DESKTOP_PARITY_URL);
});
