import { join } from "node:path";
import { readFileSync } from "node:fs";
import { app, BrowserWindow, shell } from "electron";
import { startHostBridge } from "./host-bridge";

let mainWindow: BrowserWindow | null = null;

const envToken = () => {
  if (process.env.OPENBOT_CONTROL_TOKEN) return process.env.OPENBOT_CONTROL_TOKEN;
  for (const path of [join(process.cwd(), ".env"), join(process.cwd(), "..", "..", ".env")]) {
    try {
      const match = readFileSync(path, "utf8").match(/^OPENBOT_CONTROL_TOKEN=(.+)$/m);
      if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
    } catch {
      // The packaged desktop normally receives the token through its environment.
    }
  }
  return "local-compose-only-change-me";
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#f7f7f5",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.once("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });

  const rendererUrl = process.env.OPENBOT_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(import.meta.dirname, "..", "dist", "index.html"));
};

await app.whenReady();
await createWindow();
const hostBridge = startHostBridge({
  token: envToken(),
  port: Number(process.env.OPENBOT_HOST_BRIDGE_PORT ?? 8791),
  terminalDir: join(app.getPath("userData"), "host-terminals"),
  getWindow: () => mainWindow,
});

app.on("before-quit", () => hostBridge.close());

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
