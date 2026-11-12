import { contextBridge, ipcRenderer } from "electron";
import type { AppshotRoster, AppshotSendResult, AppshotShot } from "../main/appshot";

/** The appshot overlay's whole bridge. It never sees the account token: the main window,
 * which is signed in, delivers the message. */
contextBridge.exposeInMainWorld("appshot", {
  platform: process.platform,
  onShot: (callback: (shot: AppshotShot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shot: AppshotShot) => callback(shot);
    ipcRenderer.on("appshot:shot", listener);
    return () => ipcRenderer.removeListener("appshot:shot", listener);
  },
  onRoster: (callback: (roster: AppshotRoster) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, roster: AppshotRoster) => callback(roster);
    ipcRenderer.on("appshot:roster", listener);
    return () => ipcRenderer.removeListener("appshot:roster", listener);
  },
  /** The shot has decoded: show the overlay. */
  ready: () => ipcRenderer.send("appshot:ready"),
  setInteractive: (interactive: boolean) => ipcRenderer.send("appshot:interactive", interactive === true),
  focus: () => ipcRenderer.send("appshot:focus"),
  saveDraft: (draft: string) => {
    if (typeof draft === "string") ipcRenderer.send("appshot:draft", draft.slice(0, 100_000));
  },
  send: (request: { shotId: string; botId: string; content: string }): Promise<AppshotSendResult> =>
    ipcRenderer.invoke("appshot:send", request),
  transcribe: (audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke("appshot:transcribe", { audio, mimeType }),
  /** Tagged with its shot, so a close that lands after a retake can't hide the new one. */
  close: (shotId: string) => ipcRenderer.send("appshot:closed", typeof shotId === "string" ? shotId : ""),
  openChat: (botId: string) => ipcRenderer.send("appshot:open-chat", botId),
  /** The app's rebindable shortcuts (dictate, next and previous Bot), and their changes. */
  shortcuts: {
    get: () => ipcRenderer.invoke("openteam:shortcuts:get"),
    onChange: (callback: (view: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, view: unknown) => callback(view);
      ipcRenderer.on("openteam:shortcuts-changed", listener);
      return () => ipcRenderer.removeListener("openteam:shortcuts-changed", listener);
    },
  },
  /** A shortcut only main can see (Fn for dictation). */
  onShortcut: (callback: (action: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => { if (typeof action === "string") callback(action); };
    ipcRenderer.on("appshot:shortcut", listener);
    return () => ipcRenderer.removeListener("appshot:shortcut", listener);
  },
});
