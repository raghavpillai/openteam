import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  net,
  shell,
} from "electron";
import { resolveControlToken } from "./control-token";
import { startHostBridge } from "./host-bridge";
import { isAddressInUseError } from "./host-bridge-listener";
import type { AutoReviewMode, AutoReviewResult, HostAction } from "./host-permissions";
import {
  type DesktopAgentNotificationState,
  DesktopNotificationManager,
  type DesktopNotificationSnapshot,
} from "./notifications";
import {
  type AutoReviewRuleKind,
  createPermissionSettingsStore,
  type LocalToolPermission,
  type PermissionSettings,
  type PermissionSettingsStore,
} from "./permission-settings";

let mainWindow: BrowserWindow | null = null;
let permissionSettings: PermissionSettingsStore | null = null;
let desktopNotifications: DesktopNotificationManager | null = null;
const activeNotifications = new Set<Notification>();
const localMachine = { machineId: "this-computer", label: hostname() } as const;
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#080808" : "#fbfbfb");
const releasePage = "https://github.com/raghavpillai/openbot/releases/latest";

type DesktopUpdateSnapshot = {
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string;
  status: "idle" | "checking" | "up-to-date" | "available" | "error";
  message: string | null;
};

let desktopUpdateSnapshot: DesktopUpdateSnapshot = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  downloadUrl: releasePage,
  status: "idle",
  message: null,
};

const versionParts = (value: string) =>
  value
    .replace(/^v/i, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

const isNewerVersion = (candidate: string, current: string) => {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      return (left[index] ?? 0) > (right[index] ?? 0);
    }
  }
  return false;
};

const checkForDesktopUpdate = async (): Promise<DesktopUpdateSnapshot> => {
  desktopUpdateSnapshot = { ...desktopUpdateSnapshot, status: "checking", message: null };
  try {
    const manifestUrl =
      process.env.OPENBOT_UPDATE_MANIFEST_URL ??
      "https://api.github.com/repos/raghavpillai/openbot/releases/latest";
    const response = await net.fetch(manifestUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "OpenBot-Desktop" },
    });
    if (response.status === 404) {
      desktopUpdateSnapshot = {
        ...desktopUpdateSnapshot,
        latestVersion: null,
        status: "up-to-date",
        message: "No published desktop release is available yet.",
      };
      return desktopUpdateSnapshot;
    }
    if (!response.ok) throw new Error(`Update service returned ${response.status}`);
    const result = (await response.json()) as Record<string, unknown>;
    const latestVersion = String(result.tag_name ?? result.version ?? "").replace(/^v/i, "");
    if (!latestVersion) throw new Error("Update service did not return a version");
    const candidateUrl = String(result.html_url ?? result.url ?? releasePage);
    const downloadUrl = candidateUrl.startsWith("https://") ? candidateUrl : releasePage;
    desktopUpdateSnapshot = {
      currentVersion: app.getVersion(),
      latestVersion,
      downloadUrl,
      status: isNewerVersion(latestVersion, app.getVersion()) ? "available" : "up-to-date",
      message: null,
    };
  } catch (error) {
    desktopUpdateSnapshot = {
      ...desktopUpdateSnapshot,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return desktopUpdateSnapshot;
};

interface ImageContextMenuRequest {
  altText: string;
  sourceUrl: string;
  x: number;
  y: number;
}

interface DownloadAssetRequest {
  fileName: string;
  url: string;
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
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !/^\/api\/v0\/assets\/[a-f0-9]{64}$/.test(url.pathname)
  ) {
    throw new Error("Unsupported image URL");
  }
  const response = await net.fetch(url.toString());
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

const isImageContextMenuRequest = (value: unknown): value is ImageContextMenuRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<ImageContextMenuRequest>;
  const assetUrl = (() => {
    try {
      const url = new URL(request.sourceUrl ?? "");
      return (
        ["http:", "https:"].includes(url.protocol) &&
        /^\/api\/v0\/assets\/[a-f0-9]{64}$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  })();
  return (
    typeof request.altText === "string" &&
    typeof request.sourceUrl === "string" &&
    (request.sourceUrl.startsWith("data:image/") || assetUrl) &&
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

const safeDownloadName = (value: string) => {
  const leaf = value.normalize("NFKC").split(/[\\/]/).at(-1)?.trim() || "attachment";
  const safe = Array.from(leaf, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f || /[\\/:*?"<>|]/.test(character)
      ? "_"
      : character;
  })
    .join("")
    .slice(0, 180);
  return safe || "attachment";
};

const trustedDownloadOrigins = () => {
  const origins = new Set<string>();
  for (const candidate of [
    process.env.OPENBOT_SERVER_URL ?? "http://127.0.0.1:8787",
    mainWindow?.webContents.getURL(),
  ]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Ignore malformed configuration and non-network renderer URLs such as file://.
    }
  }
  return origins;
};

const downloadAssetRequests = (value: unknown): DownloadAssetRequest[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) return null;
  const parsed = value.map((candidate): DownloadAssetRequest | null => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const request = candidate as Partial<DownloadAssetRequest>;
    if (typeof request.fileName !== "string" || typeof request.url !== "string") return null;
    try {
      const url = new URL(request.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !trustedDownloadOrigins().has(url.origin) ||
        !/^\/api\/v0\/assets\/[a-f0-9]{64}$/.test(url.pathname)
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return { fileName: safeDownloadName(request.fileName), url: request.url };
  });
  return parsed.every((candidate): candidate is DownloadAssetRequest => candidate !== null)
    ? parsed
    : null;
};

const writeUniqueDownload = async (directory: string, name: string, bytes: Buffer) => {
  const extension = extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = join(directory, suffix === 0 ? name : `${base}-${suffix + 1}${extension}`);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not choose an unused filename for ${name}`);
};

ipcMain.handle("openbot:files:download-all", async (event, value: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Downloads are unavailable");
  }
  const requests = downloadAssetRequests(value);
  if (!requests) throw new Error("Download request is invalid");
  const choice = await dialog.showOpenDialog(mainWindow, {
    defaultPath: app.getPath("downloads"),
    message: requests.length === 1 ? "Choose where to save the file" : "Choose where to save files",
    properties: ["openDirectory", "createDirectory"],
  });
  const directory = choice.filePaths[0];
  if (choice.canceled || !directory) return { canceled: true, saved: 0, directory: null };

  const failures: string[] = [];
  let saved = 0;
  for (const request of requests) {
    try {
      const response = await net.fetch(request.url);
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      await writeUniqueDownload(
        directory,
        request.fileName,
        Buffer.from(await response.arrayBuffer())
      );
      saved += 1;
    } catch (error) {
      failures.push(
        `${request.fileName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failures.length > 0) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: saved > 0 ? "Some files couldn’t be downloaded" : "Couldn’t download files",
      message: `${saved} of ${requests.length} files saved.`,
      detail: failures.join("\n").slice(0, 4_000),
    });
  }
  return { canceled: false, saved, directory };
});

ipcMain.handle("openbot:updates:status", (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  return desktopUpdateSnapshot;
});

ipcMain.handle("openbot:updates:check", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  return checkForDesktopUpdate();
});

ipcMain.handle("openbot:updates:open-download", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  await shell.openExternal(desktopUpdateSnapshot.downloadUrl || releasePage);
});

const desktopAgentState = (value: unknown): DesktopAgentNotificationState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    ![candidate.botId, candidate.channelId, candidate.name].every(
      (field) => typeof field === "string"
    ) ||
    ![candidate.notificationsEnabled, candidate.hiddenFromSidebar, candidate.isRunning].every(
      (field) => typeof field === "boolean"
    ) ||
    (candidate.awaitingReason !== null && typeof candidate.awaitingReason !== "string") ||
    (candidate.lastMessageId !== null && typeof candidate.lastMessageId !== "string") ||
    (candidate.lastMessagePreview !== null && typeof candidate.lastMessagePreview !== "string") ||
    typeof candidate.unreadCount !== "number" ||
    !Number.isFinite(candidate.unreadCount)
  ) {
    return null;
  }
  return candidate as unknown as DesktopAgentNotificationState;
};

const desktopNotificationSnapshot = (value: unknown): DesktopNotificationSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { cursor?: unknown; agents?: unknown };
  const agents = candidate.agents;
  if (
    candidate.cursor !== undefined &&
    (typeof candidate.cursor !== "string" || !/^\d+$/.test(candidate.cursor))
  ) {
    return null;
  }
  if (!Array.isArray(agents) || agents.length > 10_000) return null;
  const parsed = agents.map(desktopAgentState);
  return parsed.every((agent): agent is DesktopAgentNotificationState => Boolean(agent))
    ? { agents: parsed, ...(candidate.cursor ? { cursor: candidate.cursor } : {}) }
    : null;
};

ipcMain.on("openbot:notifications:sync", (event, request: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const snapshot = desktopNotificationSnapshot(request);
  if (snapshot) desktopNotifications?.sync(snapshot);
});

ipcMain.handle("openbot:notifications:status", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Notification status is unavailable");
  }
  const supported = Notification.isSupported();
  const delivered =
    process.platform === "darwin" && supported
      ? await Notification.getHistory()
          .then((notifications) =>
            notifications.map((notification) => ({
              id: notification.id,
              title: notification.title,
              body: notification.body,
            }))
          )
          .catch(() => [])
      : [];
  return { supported, platform: process.platform, delivered };
});

ipcMain.handle("openbot:notifications:open-settings", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Notification settings are unavailable");
  }
  if (process.platform === "darwin") {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    );
    return;
  }
  await shell.openExternal("ms-settings:notifications");
});

const requirePermissionSettings = (event: Electron.IpcMainInvokeEvent) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !permissionSettings) {
    throw new Error("Permission settings are unavailable");
  }
  return permissionSettings;
};

const permissionSettingsView = (settings: PermissionSettings) => ({
  ...settings,
  machine: {
    ...localMachine,
    label: settings.machineLabel ?? localMachine.label,
  },
});

ipcMain.handle("openbot:permissions:get", async (event) =>
  permissionSettingsView(await requirePermissionSettings(event).read())
);
ipcMain.handle("openbot:permissions:update", async (event, value: unknown) => {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const localToolPermission = ["always", "ask", "never"].includes(String(input.localToolPermission))
    ? (input.localToolPermission as LocalToolPermission)
    : undefined;
  const machineLabel =
    typeof input.machineLabel === "string" && input.machineLabel.trim()
      ? input.machineLabel.trim().slice(0, 80)
      : undefined;
  const autoReviewEnabled =
    typeof input.autoReviewEnabled === "boolean" ? input.autoReviewEnabled : undefined;
  if (
    machineLabel === undefined &&
    localToolPermission === undefined &&
    autoReviewEnabled === undefined
  ) {
    throw new Error("No valid permission setting was provided");
  }
  return permissionSettingsView(
    await requirePermissionSettings(event).update({
      machineLabel,
      localToolPermission,
      autoReviewEnabled,
    })
  );
});

const permissionRuleInput = (value: unknown): { kind: AutoReviewRuleKind; instruction: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Permission rule input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    !["allow", "block"].includes(String(input.kind)) ||
    typeof input.instruction !== "string" ||
    !input.instruction.trim() ||
    input.instruction.length > 1_000
  ) {
    throw new Error("Permission rule is invalid");
  }
  return {
    kind: input.kind as AutoReviewRuleKind,
    instruction: input.instruction.trim(),
  };
};

ipcMain.handle("openbot:permissions:add-rule", async (event, value: unknown) => {
  const input = permissionRuleInput(value);
  return permissionSettingsView(
    await requirePermissionSettings(event).addRule(input.kind, input.instruction)
  );
});
ipcMain.handle("openbot:permissions:remove-rule", async (event, value: unknown) => {
  const input = permissionRuleInput(value);
  return permissionSettingsView(
    await requirePermissionSettings(event).removeRule(input.kind, input.instruction)
  );
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
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      // Native completion and needs-input notifications depend on the renderer's
      // product-event stream even while the window is minimized.
      backgroundThrottling: false,
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
      permissionSettings = createPermissionSettingsStore(
        join(app.getPath("userData"), "permission-settings.json")
      );
      desktopNotifications = new DesktopNotificationManager({
        isFocused: () => mainWindow?.isFocused() ?? false,
        isSupported: () => Notification.isSupported(),
        setBadge: (label) => app.dock?.setBadge(label),
        deliver: (notificationEvent) => {
          const debugNotifications = process.env.OPENBOT_NOTIFICATION_DEBUG === "1";
          const notification = new Notification({
            title: notificationEvent.title,
            body: notificationEvent.body,
            silent: notificationEvent.sound === null,
            urgency: notificationEvent.urgency,
          });
          activeNotifications.add(notification);
          const release = () => activeNotifications.delete(notification);
          notification.once("close", release);
          notification.once("show", () => {
            if (debugNotifications) {
              console.info(
                "OpenBot native notification shown",
                notificationEvent.kind,
                notificationEvent.title
              );
            }
          });
          notification.once("failed", (_event, error) => {
            console.error("OpenBot native notification failed", error);
            release();
          });
          notification.on("click", () => {
            focusMainWindow();
            mainWindow?.webContents.send("openbot:notification-click", notificationEvent.channelId);
          });
          notification.show();
        },
      });
      await createWindow();
      const port = Number(process.env.OPENBOT_HOST_BRIDGE_PORT ?? 8791);
      const token = resolveControlToken({
        environmentToken: process.env.OPENBOT_CONTROL_TOKEN,
        cwd: process.cwd(),
        appPath: app.getAppPath(),
        executablePath: process.execPath,
        userDataPath: app.getPath("userData"),
      });
      const configuredMode = process.env.OPENBOT_AUTO_REVIEW_MODE;
      const autoReviewMode: AutoReviewMode = ["off", "shadow", "enforce"].includes(
        configuredMode ?? ""
      )
        ? (configuredMode as AutoReviewMode)
        : "enforce";
      const reviewAction = async (
        action: HostAction,
        rules: { allowInstructions: string[]; blockInstructions: string[] }
      ): Promise<AutoReviewResult> => {
        const serverUrl = process.env.OPENBOT_SERVER_URL ?? "http://127.0.0.1:8787";
        const response = await fetch(`${serverUrl}/api/v0/internal/permissions/auto-review`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...action,
            allowInstructions: rules.allowInstructions,
            blockInstructions: rules.blockInstructions,
          }),
          signal: AbortSignal.timeout(16_000),
        });
        if (!response.ok) {
          return {
            decision: "reject",
            reason: `Auto Review service failed (${response.status})`,
          };
        }
        const result = (await response.json()) as Partial<AutoReviewResult>;
        if (
          !["allow", "block", "reject"].includes(String(result.decision)) ||
          typeof result.reason !== "string"
        ) {
          return {
            decision: "reject",
            reason: "Auto Review returned an invalid response",
          };
        }
        return {
          decision: result.decision as AutoReviewResult["decision"],
          reason: result.reason.slice(0, 500),
          ...(typeof result.proposedRule === "string"
            ? { proposedRule: result.proposedRule.slice(0, 500) }
            : {}),
        };
      };
      try {
        hostBridge = await startHostBridge({
          token,
          port,
          terminalDir: join(app.getPath("userData"), "host-terminals"),
          permissionSettings,
          autoReviewMode,
          machineId: localMachine.machineId,
          machineLabel: localMachine.label,
          reviewAction,
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

app.on("before-quit", () => {
  desktopNotifications?.clear();
  hostBridge?.close();
});

nativeTheme.on("updated", () => mainWindow?.setBackgroundColor(windowBackground()));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
