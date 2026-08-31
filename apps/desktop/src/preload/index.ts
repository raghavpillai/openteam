import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openbot", {
  platform: process.platform,
  permissions: {
    get: () => ipcRenderer.invoke("openbot:permissions:get"),
    update: (request: {
      machineLabel?: string;
      localToolPermission?: "always" | "ask" | "never";
      autoReviewEnabled?: boolean;
    }) => ipcRenderer.invoke("openbot:permissions:update", request),
    addRule: (request: { kind: "allow" | "block"; instruction: string }) =>
      ipcRenderer.invoke("openbot:permissions:add-rule", request),
    removeRule: (request: { kind: "allow" | "block"; instruction: string }) =>
      ipcRenderer.invoke("openbot:permissions:remove-rule", request),
  },
  showImageContextMenu: (request: { altText: string; sourceUrl: string; x: number; y: number }) =>
    ipcRenderer.send("openbot:image-context-menu", request),
  files: {
    downloadAll: (files: Array<{ fileName: string; url: string }>) =>
      ipcRenderer.invoke("openbot:files:download-all", files),
  },
  updates: {
    status: () => ipcRenderer.invoke("openbot:updates:status"),
    check: () => ipcRenderer.invoke("openbot:updates:check"),
    openDownload: () => ipcRenderer.invoke("openbot:updates:open-download"),
  },
  notifications: {
    sync: (snapshot: unknown) => ipcRenderer.send("openbot:notifications:sync", snapshot),
    status: () => ipcRenderer.invoke("openbot:notifications:status"),
    openSettings: () => ipcRenderer.invoke("openbot:notifications:open-settings"),
  },
  onNotificationClick: (listener: (channelId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channelId: unknown) => {
      if (typeof channelId === "string") listener(channelId);
    };
    ipcRenderer.on("openbot:notification-click", handler);
    return () => ipcRenderer.removeListener("openbot:notification-click", handler);
  },
  versions: Object.freeze({
    app: process.env.npm_package_version ?? "0.1.0",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
});
