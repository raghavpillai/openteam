const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(process.env.COMPUTER_VIEW_DIR, "profile"));
app.whenReady().then(async () => {
  const reports = [];
  const frameReports = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 780,
    webPreferences: { backgroundThrottling: false },
  });
  const runScenario = async (query, prefix, page = process.env.COMPUTER_VIEW_URL) => {
    const result = new Promise((resolve) => {
      const receive = (event) => {
        if (event.message.startsWith(prefix)) {
          win.webContents.removeListener("console-message", receive);
          resolve(JSON.parse(event.message.slice(prefix.length)));
        }
        else if (event.level === "error") console.error(event.message);
      };
      win.webContents.on("console-message", receive);
    });
    await win.loadURL(`${page}?${query}`);
    return result;
  };
  for (const theme of ["light", "dark"]) {
    reports.push(await runScenario(`inspector&regression&theme=${theme}`, "COMPUTER_VIEW_RESULT "));
    frameReports.push(await runScenario(`inspector&frame-refresh&frame-regression&theme=${theme}`, "SCREEN_FRAME_RESULT "));
  }
  const resourceReport = await runScenario("", "RESOURCE_REFRESH_RESULT ",
    new URL("authenticated-resource-refresh.html", process.env.COMPUTER_VIEW_URL).href);
  fs.writeFileSync(
    path.join(process.env.COMPUTER_VIEW_DIR, "results.json"),
    JSON.stringify({ reports, frameReports, resourceReport })
  );
  app.quit();
});
