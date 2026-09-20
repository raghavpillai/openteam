const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.COMPUTER_VIEW_DIR, "profile"));
app.whenReady().then(async () => {
  const reports = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 780,
    webPreferences: { backgroundThrottling: false },
  });
  for (const theme of ["light", "dark"]) {
    const result = new Promise((resolve) =>
      win.webContents.on("console-message", (event) => {
        if (event.message.startsWith("COMPUTER_VIEW_RESULT "))
          resolve(JSON.parse(event.message.slice("COMPUTER_VIEW_RESULT ".length)));
        else if (event.level === "error") console.error(event.message);
      })
    );
    await win.loadURL(`${process.env.COMPUTER_VIEW_URL}?inspector&regression&theme=${theme}`);
    reports.push(await result);
  }
  fs.writeFileSync(
    path.join(process.env.COMPUTER_VIEW_DIR, "results.json"),
    JSON.stringify({ reports })
  );
  app.quit();
});
