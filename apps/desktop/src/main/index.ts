import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  shell,
} from "electron";
import { resolveControlToken } from "./control-token";
import { startHostBridge } from "./host-bridge";
import { isAddressInUseError } from "./host-bridge-listener";

let mainWindow: BrowserWindow | null = null;
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#080808" : "#fbfbfb");

interface ImageContextMenuRequest {
  altText: string;
  sourceUrl: string;
  x: number;
  y: number;
}

interface DesktopNotificationRequest {
  channelId: string;
  title: string;
  body: string;
  kind: "agent-needs-input" | "agent-done";
}

const imageExtensionFor = (sourceUrl: string) => {
  const mime = /^data:(image\/[^;,]+)/i.exec(sourceUrl)?.[1]?.toLowerCase();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/svg+xml") return ".svg";
  try {
    const extension = new URL(sourceUrl).pathname.match(/\.(png|jpe?g|webp|gif|svg)$/i)?.[0];
    if (extension) return extension.toLowerCase() === ".jpeg" ? ".jpg" : extension.toLowerCase();
  } catch {
    // Data URLs and malformed external URLs fall back to PNG.
  }
  return ".png";
};

const imageFilenameFor = (sourceUrl: string, altText: string) => {
  const candidate = altText || "image";
  const withoutControls = Array.from(candidate, (character) =>
    character.charCodeAt(0) < 32 ? "-" : character
  ).join("");
  const safe =
    withoutControls
      .replace(/[\\/:*?"<>|]/g, "-")
      .trim()
      .slice(0, 180) || "image";
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(safe)
    ? safe
    : `${safe}${imageExtensionFor(sourceUrl)}`;
};

const loadImageBytes = async (sourceUrl: string) => {
  if (sourceUrl.startsWith("data:")) {
    const separator = sourceUrl.indexOf(",");
    if (separator < 0) throw new Error("Invalid image data URL");
    const metadata = sourceUrl.slice(5, separator);
    const payload = sourceUrl.slice(separator + 1);
    return metadata.split(";").includes("base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload));
  }
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("Unsupported image URL");
  const response = await net.fetch(url.toString());
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

const isImageContextMenuRequest = (value: unknown): value is ImageContextMenuRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<ImageContextMenuRequest>;
  return (
    typeof request.altText === "string" &&
    typeof request.sourceUrl === "string" &&
    (request.sourceUrl.startsWith("data:image/") || request.sourceUrl.startsWith("https://")) &&
    typeof request.x === "number" &&
    Number.isFinite(request.x) &&
    typeof request.y === "number" &&
    Number.isFinite(request.y)
  );
};

const showImageContextMenu = (window: BrowserWindow, request: ImageContextMenuRequest) => {
  const menu = Menu.buildFromTemplate([
    {
      label: "Copy image",
      click: () => window.webContents.copyImageAt(request.x, request.y),
    },
    {
      label: "Save image…",
      click: () => {
        void (async () => {
          const filename = imageFilenameFor(request.sourceUrl, request.altText);
          const result = await dialog.showSaveDialog(window, {
            defaultPath: join(app.getPath("downloads"), filename),
          });
          if (result.canceled || !result.filePath) return;
          try {
            await writeFile(result.filePath, await loadImageBytes(request.sourceUrl));
          } catch (error) {
            await dialog.showMessageBox(window, {
              type: "error",
              title: "Couldn’t save image",
              message: "The image could not be saved.",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      },
    },
    {
      label: "Copy image address",
      click: () => clipboard.writeText(request.sourceUrl),
    },
  ]);
  menu.popup({ window });
};

ipcMain.on("openbot:image-context-menu", (event, request: unknown) => {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !isImageContextMenuRequest(request)
  ) {
    return;
  }
  showImageContextMenu(mainWindow, request);
});

ipcMain.on("openbot:notification", (event, request: unknown) => {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    mainWindow.isFocused() ||
    !request ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    return;
  }
  const candidate = request as Partial<DesktopNotificationRequest>;
  if (
    typeof candidate.channelId !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.body !== "string" ||
    !["agent-needs-input", "agent-done"].includes(candidate.kind ?? "")
  ) {
    return;
  }
  const notification = new Notification({ title: candidate.title, body: candidate.body });
  notification.on("click", () => {
    focusMainWindow();
    mainWindow?.webContents.send("openbot:notification-click", candidate.channelId);
  });
  notification.show();
});

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1470,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: windowBackground(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
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

let hostBridge: Awaited<ReturnType<typeof startHostBridge>> | null = null;

const focusMainWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

// Development builds can run beside an installed app by design, but packaged launches should
// reuse the existing desktop instance instead of competing for its host bridge port.
const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();

app.on("second-instance", focusMainWindow);

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      await createWindow();
      const port = Number(process.env.OPENBOT_HOST_BRIDGE_PORT ?? 8791);
      try {
        hostBridge = await startHostBridge({
          token: resolveControlToken({
            environmentToken: process.env.OPENBOT_CONTROL_TOKEN,
            cwd: process.cwd(),
            appPath: app.getAppPath(),
            executablePath: process.execPath,
            userDataPath: app.getPath("userData"),
          }),
          port,
          terminalDir: join(app.getPath("userData"), "host-terminals"),
          getWindow: () => mainWindow,
        });
      } catch (error) {
        if (!isAddressInUseError(error)) throw error;
        console.warn(`OpenBot host bridge port ${port} is already in use; continuing without it.`);
      }

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error) => {
      console.error("Failed to start OpenBot desktop", error);
      app.quit();
    });
}

app.on("before-quit", () => hostBridge?.close());

nativeTheme.on("updated", () => mainWindow?.setBackgroundColor(windowBackground()));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
