import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("openbot", {
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
});
