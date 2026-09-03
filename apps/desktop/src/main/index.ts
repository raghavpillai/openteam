import { open, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, join } from "node:path";
import {
  compareOpenTeamVersions,
  isOpenTeamVersion,
} from "@openteam/contracts/version-compatibility";
import { safeErrorMessage } from "@openteam/product-core/redaction";
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
  protocol,
  safeStorage,
  shell,
} from "electron";
import type { AppUpdater } from "electron-updater";
import { DesktopAuthTokenStore } from "./auth-token-store";
import { resolveControlToken } from "./control-token";
import {
  MAX_IMAGE_SAVE_BYTES,
  writeBytesFully,
  writeDataUrlToFileAtomically,
} from "./data-url-file";
import { discardDeliveryFiles, readDeliveryFile, stageDeliveryFile } from "./delivery-file-stage";
import { DurableSendJournalStore } from "./durable-send-journal-store";
import { startHostBridge } from "./host-bridge";
import { isAddressInUseError } from "./host-bridge-listener";
import { HostJobManager } from "./host-job-manager";
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
import { ServerUpdater } from "./server-updater";
import {
  classifyDesktopUpdateError,
  type DesktopUpdateSnapshot,
  parseDesktopReleaseManifest,
} from "./update-status";

let mainWindow: BrowserWindow | null = null;
let authTokenStore: DesktopAuthTokenStore | null = null;
let permissionSettings: PermissionSettingsStore | null = null;
let desktopNotifications: DesktopNotificationManager | null = null;
let durableSendJournals: DurableSendJournalStore | null = null;
const activeNotifications = new Set<Notification>();
const localMachine = { machineId: "this-computer", label: hostname() } as const;
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#080808" : "#fbfbfb");
const releasePage = "https://github.com/raghavpillai/openteam/releases/latest";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "openteam-staged",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let desktopUpdateSnapshot: DesktopUpdateSnapshot = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  downloadUrl: releasePage,
  status: "idle",
  progress: null,
  message: null,
  failureKind: null,
  track: "stable",
};

let desktopUpdaterConfigured = false;
let desktopUpdaterPromise: Promise<AppUpdater> | null = null;
let desktopUpdateTimer: ReturnType<typeof setInterval> | null = null;
const publishDesktopUpdate = (next: Partial<DesktopUpdateSnapshot>) => {
  desktopUpdateSnapshot = { ...desktopUpdateSnapshot, ...next };
  mainWindow?.webContents.send("openteam:desktop-update-progress", desktopUpdateSnapshot);
};

const loadDesktopUpdater = () => {
  desktopUpdaterPromise ??= import("electron-updater").then((module) => module.autoUpdater);
  return desktopUpdaterPromise;
};

const configureDesktopUpdater = async (): Promise<AppUpdater | null> => {
  if (!app.isPackaged) return null;
  const autoUpdater = await loadDesktopUpdater();
  if (desktopUpdaterConfigured) return autoUpdater;
  desktopUpdaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.on("checking-for-update", () =>
    publishDesktopUpdate({ status: "checking", progress: null, message: null, failureKind: null })
  );
  autoUpdater.on("update-available", (info) =>
    publishDesktopUpdate({
      status: "available",
      latestVersion: info.version,
      progress: null,
      message: null,
      failureKind: null,
    })
  );
  autoUpdater.on("update-not-available", (info) =>
    publishDesktopUpdate({
      status: "up-to-date",
      latestVersion: info.version,
      progress: null,
      message: "You’re up to date",
      failureKind: null,
    })
  );
  autoUpdater.on("download-progress", (progress) =>
    publishDesktopUpdate({
      status: "downloading",
      progress: Math.max(0, Math.min(100, progress.percent)),
      message: `Downloading ${Math.round(progress.percent)}%`,
      failureKind: null,
    })
  );
  autoUpdater.on("update-downloaded", (info) =>
    publishDesktopUpdate({
      status: "downloaded",
      latestVersion: info.version,
      progress: 100,
      message: "Restart OpenTeam to finish installing the update",
      failureKind: null,
    })
  );
  autoUpdater.on("error", (error) => {
    const failure = classifyDesktopUpdateError(error, desktopUpdateSnapshot.status);
    publishDesktopUpdate({ status: "error", progress: null, ...failure });
  });
  return autoUpdater;
};

const scheduleDesktopUpdateChecks = () => {
  if (!app.isPackaged || desktopUpdateTimer) return;
  const check = () => {
    if (
      ["checking", "downloading", "downloaded", "installing"].includes(desktopUpdateSnapshot.status)
    ) {
      return;
    }
    void checkForDesktopUpdate().catch((error) =>
      console.warn("Automatic desktop update check failed", safeErrorMessage(error))
    );
  };
  const initial = setTimeout(check, 15_000);
  initial.unref?.();
  desktopUpdateTimer = setInterval(check, 6 * 60 * 60_000);
  desktopUpdateTimer.unref?.();
};

const serverUpdater = new ServerUpdater({
  cliPath: app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "dist-electron", "openteam-cli.js")
    : join(import.meta.dirname, "openteam-cli.js"),
  executablePath: process.execPath,
  fetcher: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  onStatus: (status) => mainWindow?.webContents.send("openteam:server-update-progress", status),
});

const checkForDesktopUpdate = async (): Promise<DesktopUpdateSnapshot> => {
  desktopUpdateSnapshot = {
    ...desktopUpdateSnapshot,
    status: "checking",
    progress: null,
    message: null,
    failureKind: null,
  };
  try {
    if (app.isPackaged) {
      const autoUpdater = await configureDesktopUpdater();
      if (!autoUpdater) throw new Error("The desktop update service is unavailable");
      const result = await autoUpdater.checkForUpdates();
      if (!result) throw new Error("The desktop update service did not return a result");
      desktopUpdateSnapshot = {
        ...desktopUpdateSnapshot,
        latestVersion: result.updateInfo.version,
        status: result.isUpdateAvailable ? "available" : "up-to-date",
        message: result.isUpdateAvailable ? null : "You’re up to date",
        failureKind: null,
      };
      return desktopUpdateSnapshot;
    }
    const manifestUrl =
      process.env.OPENTEAM_UPDATE_MANIFEST_URL ??
      "https://api.github.com/repos/raghavpillai/openteam/releases/latest";
    const response = await net.fetch(manifestUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "OpenTeam-Desktop" },
    });
    if (response.status === 404) {
      desktopUpdateSnapshot = {
        ...desktopUpdateSnapshot,
        latestVersion: null,
        status: "up-to-date",
        progress: null,
        message: "No published desktop release is available yet.",
        failureKind: null,
      };
      return desktopUpdateSnapshot;
    }
    if (!response.ok) throw new Error(`Update service returned ${response.status}`);
    const release = parseDesktopReleaseManifest(await response.json(), releasePage);
    const updateAvailable = (compareOpenTeamVersions(release.version, app.getVersion()) ?? 0) > 0;
    desktopUpdateSnapshot = {
      currentVersion: app.getVersion(),
      latestVersion: release.version,
      downloadUrl: release.downloadUrl,
      status: updateAvailable ? "available" : "up-to-date",
      progress: null,
      message: updateAvailable ? null : "You’re up to date",
      failureKind: null,
      track: "stable",
    };
  } catch (error) {
    const failure = classifyDesktopUpdateError(error, desktopUpdateSnapshot.status);
    desktopUpdateSnapshot = {
      ...desktopUpdateSnapshot,
      status: "error",
      progress: null,
      ...failure,
    };
  }
  return desktopUpdateSnapshot;
};

interface ImageContextMenuRequest {
  altText: string;
  sourceUrl: string;
  x: number;
  y: number;
  suggestedFilename?: string;
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

const saveRendererBlobTo = (window: BrowserWindow, sourceUrl: string, destination: string) =>
  new Promise<void>((resolve, reject) => {
    const session = window.webContents.session;
    const timeout = setTimeout(() => finish(new Error("Image download did not start")), 10_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      session.removeListener("will-download", onDownload);
      if (error) reject(error);
      else resolve();
    };
    const onDownload = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
      webContents: Electron.WebContents
    ) => {
      if (webContents !== window.webContents || item.getURL() !== sourceUrl) return;
      item.setSavePath(destination);
      item.once("done", (_doneEvent, state) => {
        finish(state === "completed" ? undefined : new Error(`Image download ${state}`));
      });
    };
    session.on("will-download", onDownload);
    try {
      window.webContents.downloadURL(sourceUrl);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

const saveImageTo = async (window: BrowserWindow, sourceUrl: string, destination: string) => {
  if (sourceUrl.startsWith("blob:")) {
    await saveRendererBlobTo(window, sourceUrl, destination);
    return;
  }
  if (sourceUrl.startsWith("data:")) {
    await writeDataUrlToFileAtomically(sourceUrl, destination, {
      maxBytes: MAX_IMAGE_SAVE_BYTES,
    });
    return;
  }
  const temporary = `${destination}.openteam-${crypto.randomUUID()}.tmp`;
  const url = new URL(sourceUrl);
  const loopbackHttp =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) throw new Error("Unsupported image URL");
  const response = await net.fetch(url.toString());
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  if (!response.body) throw new Error("Image response was empty");
  const file = await open(temporary, "wx", 0o600);
  let bytesWritten = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytesWritten += chunk.byteLength;
      if (bytesWritten > MAX_IMAGE_SAVE_BYTES) throw new Error("Image exceeds 100 MiB");
      await writeBytesFully(file, chunk);
    }
    await file.close();
    await rename(temporary, destination);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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
          const filename =
            request.suggestedFilename || imageFilenameFor(request.sourceUrl, request.altText);
          const result = await dialog.showSaveDialog(window, {
            defaultPath: join(app.getPath("downloads"), filename),
          });
          if (result.canceled || !result.filePath) return;
          try {
            await saveImageTo(window, request.sourceUrl, result.filePath);
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
    process.env.OPENTEAM_SERVER_URL ?? "http://127.0.0.1:8787",
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

const writeUniqueDownload = async (directory: string, name: string, url: string) => {
  const extension = extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = join(directory, suffix === 0 ? name : `${base}-${suffix + 1}${extension}`);
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      file = await open(candidate, "wx", 0o600);
      const response = await net.fetch(url);
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      if (!response.body) throw new Error("request returned an empty body");
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await writeBytesFully(file, chunk);
      }
      await file.close();
      return candidate;
    } catch (error) {
      await file?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (file) await unlink(candidate).catch(() => undefined);
      throw error;
    }
  }
  throw new Error(`Could not choose an unused filename for ${name}`);
};

ipcMain.handle("openteam:files:download-all", async (event, value: unknown) => {
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
      await writeUniqueDownload(directory, request.fileName, request.url);
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

const deliveryStageDirectory = () => join(app.getPath("userData"), "durable-send-files");
const requireDeliveryStageSender = (event: Electron.IpcMainInvokeEvent) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Delivery file staging is unavailable");
  }
};

ipcMain.handle("openteam:files:stage-delivery", async (event, value: unknown) => {
  requireDeliveryStageSender(event);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Delivery staging request is invalid");
  }
  const request = value as Record<string, unknown>;
  const bytes = request.bytes;
  if (
    typeof request.stagingId !== "string" ||
    !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
  ) {
    throw new Error("Delivery staging request is invalid");
  }
  await stageDeliveryFile(deliveryStageDirectory(), {
    stagingId: request.stagingId,
    bytes:
      bytes instanceof ArrayBuffer
        ? bytes
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
});

ipcMain.handle("openteam:files:read-delivery-stage", async (event, stagingId: unknown) => {
  requireDeliveryStageSender(event);
  if (typeof stagingId !== "string") throw new Error("Delivery staging ID is invalid");
  return readDeliveryFile(deliveryStageDirectory(), stagingId);
});

ipcMain.handle("openteam:files:discard-delivery-stages", async (event, stagingIds: unknown) => {
  requireDeliveryStageSender(event);
  if (
    !Array.isArray(stagingIds) ||
    stagingIds.length > 24 ||
    !stagingIds.every((value) => typeof value === "string")
  ) {
    throw new Error("Delivery staging IDs are invalid");
  }
  await discardDeliveryFiles(deliveryStageDirectory(), stagingIds);
});

const requireDurableSendJournals = (event: Electron.IpcMainInvokeEvent) => {
  requireDeliveryStageSender(event);
  durableSendJournals ??= new DurableSendJournalStore(
    join(app.getPath("userData"), "durable-send-journal")
  );
  return durableSendJournals;
};

ipcMain.handle("openteam:delivery-journal:read", (event, scope: unknown) => {
  if (typeof scope !== "string") throw new Error("Delivery journal scope is invalid");
  return requireDurableSendJournals(event).read(scope);
});

ipcMain.handle("openteam:delivery-journal:write", (event, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Delivery journal write is invalid");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.scope !== "string") throw new Error("Delivery journal scope is invalid");
  return requireDurableSendJournals(event).write(request.scope, request.journal);
});

ipcMain.handle("openteam:updates:status", (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  return desktopUpdateSnapshot;
});

const requireAuthTokenStore = (event: Electron.IpcMainInvokeEvent) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !authTokenStore) {
    throw new Error("Secure authentication storage is unavailable");
  }
  return authTokenStore;
};

ipcMain.handle("openteam:auth-token:read", (event) => requireAuthTokenStore(event).read());
ipcMain.handle("openteam:auth-token:write", (event, value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 16 * 1024) {
    throw new Error("Authentication token is invalid");
  }
  return requireAuthTokenStore(event).write(value);
});
ipcMain.handle("openteam:auth-token:clear", (event) => requireAuthTokenStore(event).clear());

ipcMain.handle("openteam:updates:check", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  return checkForDesktopUpdate();
});

ipcMain.handle("openteam:updates:open-download", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Update status is unavailable");
  }
  if (app.isPackaged) {
    const autoUpdater = await configureDesktopUpdater();
    if (!autoUpdater) throw new Error("The desktop update service is unavailable");
    if (desktopUpdateSnapshot.status !== "available") {
      throw new Error("Check for a desktop update before downloading it");
    }
    publishDesktopUpdate({
      status: "downloading",
      progress: 0,
      message: "Starting download",
      failureKind: null,
    });
    await autoUpdater.downloadUpdate();
    return;
  }
  await shell.openExternal(desktopUpdateSnapshot.downloadUrl || releasePage);
});

ipcMain.handle("openteam:updates:install-client", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Desktop update installation is unavailable");
  }
  if (!app.isPackaged || desktopUpdateSnapshot.status !== "downloaded") {
    throw new Error("Download the desktop update before installing it");
  }
  publishDesktopUpdate({
    status: "installing",
    message: "Restarting to install the update",
    failureKind: null,
  });
  const autoUpdater = await configureDesktopUpdater();
  if (!autoUpdater) throw new Error("The desktop update service is unavailable");
  autoUpdater.quitAndInstall(false, true);
});

const serverUpdateRequest = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Server update request is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.serverUrl !== "string" || candidate.serverUrl.length > 2_000) {
    throw new Error("Server URL is invalid");
  }
  if (
    candidate.targetVersion !== undefined &&
    candidate.targetVersion !== null &&
    (typeof candidate.targetVersion !== "string" || !isOpenTeamVersion(candidate.targetVersion))
  ) {
    throw new Error("Target version is invalid");
  }
  if (
    candidate.sshTarget !== undefined &&
    candidate.sshTarget !== null &&
    typeof candidate.sshTarget !== "string"
  ) {
    throw new Error("SSH destination is invalid");
  }
  const targetVersion =
    typeof candidate.targetVersion === "string" ? candidate.targetVersion.replace(/^v/i, "") : null;
  const sshTarget =
    typeof candidate.sshTarget === "string" ? candidate.sshTarget.trim() || null : null;
  return { serverUrl: candidate.serverUrl, targetVersion, sshTarget };
};

ipcMain.handle("openteam:updates:server-status", async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Server update status is unavailable");
  }
  const request = serverUpdateRequest(value);
  return serverUpdater.status(request.serverUrl, request.targetVersion, request.sshTarget);
});

ipcMain.handle("openteam:updates:update-server", async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Server update is unavailable");
  }
  const request = serverUpdateRequest(value);
  return serverUpdater.update(request.serverUrl, request.targetVersion, request.sshTarget);
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

ipcMain.on("openteam:notifications:sync", (event, request: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const snapshot = desktopNotificationSnapshot(request);
  if (snapshot) desktopNotifications?.sync(snapshot);
});

ipcMain.on("openteam:notifications:visible-channel", (event, channelId: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (
    channelId !== null &&
    (typeof channelId !== "string" || !channelId.trim() || channelId.length > 512)
  ) {
    return;
  }
  desktopNotifications?.setVisibleChannel(channelId as string | null);
});

ipcMain.handle("openteam:notifications:status", async (event) => {
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

ipcMain.handle("openteam:notifications:open-settings", async (event) => {
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

ipcMain.handle("openteam:permissions:get", async (event) =>
  permissionSettingsView(await requirePermissionSettings(event).read())
);
ipcMain.handle("openteam:permissions:update", async (event, value: unknown) => {
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

ipcMain.handle("openteam:permissions:add-rule", async (event, value: unknown) => {
  const input = permissionRuleInput(value);
  return permissionSettingsView(
    await requirePermissionSettings(event).addRule(input.kind, input.instruction)
  );
});
ipcMain.handle("openteam:permissions:remove-rule", async (event, value: unknown) => {
  const input = permissionRuleInput(value);
  return permissionSettingsView(
    await requirePermissionSettings(event).removeRule(input.kind, input.instruction)
  );
});

ipcMain.handle("openteam:performance-snapshot", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Performance metrics are only available to the main window");
  }
  return {
    at: Date.now(),
    app: app.getAppMetrics(),
    main: await process.getProcessMemoryInfo(),
    gpu: app.getGPUFeatureStatus(),
  };
});

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1470,
    height: 920,
    minWidth: 512,
    minHeight: 520,
    backgroundColor: windowBackground(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      additionalArguments: [`--openteam-app-version=${encodeURIComponent(app.getVersion())}`],
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
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image" || !params.hasImageContents || !params.srcURL) return;
    showImageContextMenu(mainWindow as BrowserWindow, {
      altText: params.altText,
      sourceUrl: params.srcURL,
      x: params.x,
      y: params.y,
      suggestedFilename: params.suggestedFilename,
    });
  });
  mainWindow.webContents.on("unresponsive", () =>
    console.warn("OpenTeam renderer became unresponsive")
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) =>
    console.error("OpenTeam renderer process exited", details)
  );
  // Never expose the packaged preload bridge to an environment-selected page.
  // Development retains explicit remote/Tailscale renderer support by design.
  const rendererUrl = app.isPackaged ? undefined : process.env.OPENTEAM_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(import.meta.dirname, "..", "dist", "index.html"));
};

let hostBridge: Awaited<ReturnType<typeof startHostBridge>> | null = null;
const hostJobs = new HostJobManager();

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
app.on("child-process-gone", (_event, details) =>
  console.error("OpenTeam child process exited", details)
);

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      authTokenStore = new DesktopAuthTokenStore(
        join(app.getPath("userData"), "auth-session.bin"),
        {
          backend: () => {
            if (process.platform !== "linux")
              return process.platform === "darwin" ? "keychain" : "dpapi";
            try {
              return safeStorage.getSelectedStorageBackend();
            } catch {
              return "unavailable";
            }
          },
          decrypt: (value) => safeStorage.decryptString(value),
          encrypt: (value) => safeStorage.encryptString(value),
          isAvailable: () => {
            if (!safeStorage.isEncryptionAvailable()) return false;
            if (process.platform !== "linux") return true;
            try {
              return safeStorage.getSelectedStorageBackend() !== "basic_text";
            } catch {
              return false;
            }
          },
        }
      );
      const authStorageWarmup = authTokenStore.read();
      await protocol.handle("openteam-staged", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== "file") return new Response("Not found", { status: 404 });
          const id = url.pathname.replace(/^\//, "");
          const mimeType = url.searchParams.get("mime") ?? "application/octet-stream";
          if (!mimeType.startsWith("image/")) return new Response("Not found", { status: 404 });
          const bytes = await readDeliveryFile(deliveryStageDirectory(), id);
          return new Response(Uint8Array.from(bytes).buffer, {
            headers: { "content-type": mimeType, "cache-control": "no-store" },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      permissionSettings = createPermissionSettingsStore(
        join(app.getPath("userData"), "permission-settings.json")
      );
      desktopNotifications = new DesktopNotificationManager({
        isFocused: () => mainWindow?.isFocused() ?? false,
        isSupported: () => Notification.isSupported(),
        setBadge: (label) => app.dock?.setBadge(label),
        deliver: (notificationEvent) => {
          const debugNotifications = process.env.OPENTEAM_NOTIFICATION_DEBUG === "1";
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
                "OpenTeam native notification shown",
                notificationEvent.kind,
                notificationEvent.title
              );
            }
          });
          notification.once("failed", (_event, error) => {
            console.error("OpenTeam native notification failed", error);
            release();
          });
          notification.on("click", () => {
            focusMainWindow();
            mainWindow?.webContents.send(
              "openteam:notification-click",
              notificationEvent.channelId
            );
          });
          notification.show();
        },
      });
      const [, authStorage] = await Promise.all([createWindow(), authStorageWarmup]);
      if (authStorage.persistence === "memory") {
        console.warn(
          "OpenTeam OS secure storage is unavailable; the desktop session will remain in memory and will not persist after restart."
        );
      }
      scheduleDesktopUpdateChecks();
      const port = Number(process.env.OPENTEAM_HOST_BRIDGE_PORT ?? 8791);
      const token = resolveControlToken({
        environmentToken: process.env.OPENTEAM_CONTROL_TOKEN,
        cwd: process.cwd(),
        appPath: app.getAppPath(),
        executablePath: process.execPath,
        userDataPath: app.getPath("userData"),
      });
      const configuredMode = process.env.OPENTEAM_AUTO_REVIEW_MODE;
      const autoReviewMode: AutoReviewMode = ["off", "shadow", "enforce"].includes(
        configuredMode ?? ""
      )
        ? (configuredMode as AutoReviewMode)
        : "enforce";
      const reviewAction = async (
        action: HostAction,
        rules: { allowInstructions: string[]; blockInstructions: string[] }
      ): Promise<AutoReviewResult> => {
        const serverUrl = process.env.OPENTEAM_SERVER_URL ?? "http://127.0.0.1:8787";
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
          runJob: hostJobs.run,
        });
      } catch (error) {
        if (!isAddressInUseError(error)) throw error;
        console.warn(`OpenTeam host bridge port ${port} is already in use; continuing without it.`);
      }

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error) => {
      console.error("Failed to start OpenTeam desktop", safeErrorMessage(error));
      app.quit();
    });
}

app.on("before-quit", () => {
  if (desktopUpdateTimer) clearInterval(desktopUpdateTimer);
  desktopUpdateTimer = null;
  desktopNotifications?.clear();
  hostBridge?.close();
  hostJobs.close();
});

nativeTheme.on("updated", () => mainWindow?.setBackgroundColor(windowBackground()));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
