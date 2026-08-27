import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openbot", {
  platform: process.platform,
  showImageContextMenu: (request: { altText: string; sourceUrl: string; x: number; y: number }) =>
    ipcRenderer.send("openbot:image-context-menu", request),
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
});
