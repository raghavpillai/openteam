import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openbot", {
  platform: process.platform,
  showImageContextMenu: (request: { altText: string; sourceUrl: string; x: number; y: number }) =>
    ipcRenderer.send("openbot:image-context-menu", request),
  showNotification: (request: {
    channelId: string;
    title: string;
    body: string;
    kind: "agent-needs-input" | "agent-done";
  }) => ipcRenderer.send("openbot:notification", request),
  onNotificationClick: (listener: (channelId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channelId: unknown) => {
      if (typeof channelId === "string") listener(channelId);
    };
    ipcRenderer.on("openbot:notification-click", handler);
    return () => ipcRenderer.removeListener("openbot:notification-click", handler);
  },
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
});
