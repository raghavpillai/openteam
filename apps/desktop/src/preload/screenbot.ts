import { contextBridge, ipcRenderer } from "electron";
import type { ScreenBotRoster, ScreenBotSendResult, ScreenBotShot } from "../main/screenbot";

/** The screenbot overlay's whole bridge. It never sees the account token: the main window,
 * which is signed in, delivers the message. */
contextBridge.exposeInMainWorld("screenbot", {
  platform: process.platform,
  onShot: (callback: (shot: ScreenBotShot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shot: ScreenBotShot) => callback(shot);
    ipcRenderer.on("screenbot:shot", listener);
    return () => ipcRenderer.removeListener("screenbot:shot", listener);
  },
  /** Main hid the window (⌘W, opening the chat): stop whatever was going on. */
  onHidden: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("screenbot:hidden", listener);
    return () => ipcRenderer.removeListener("screenbot:hidden", listener);
  },
  onRoster: (callback: (roster: ScreenBotRoster) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, roster: ScreenBotRoster) => callback(roster);
    ipcRenderer.on("screenbot:roster", listener);
    return () => ipcRenderer.removeListener("screenbot:roster", listener);
  },
  /** The shot has decoded: show the overlay. */
  ready: () => ipcRenderer.send("screenbot:ready"),
  setInteractive: (interactive: boolean) => ipcRenderer.send("screenbot:interactive", interactive === true),
  focus: () => ipcRenderer.send("screenbot:focus"),
  saveDraft: (draft: string) => {
    if (typeof draft === "string") ipcRenderer.send("screenbot:draft", draft.slice(0, 100_000));
  },
  send: (request: { shotId: string; botId: string; content: string }): Promise<ScreenBotSendResult> =>
    ipcRenderer.invoke("screenbot:send", request),
  transcribe: (audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke("screenbot:transcribe", { audio, mimeType }),
  /** Tagged with its shot, so a close that lands after a retake can't hide the new one. */
  close: (shotId: string) => ipcRenderer.send("screenbot:closed", typeof shotId === "string" ? shotId : ""),
  openChat: (botId: string) => ipcRenderer.send("screenbot:open-chat", botId),
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
    ipcRenderer.on("screenbot:shortcut", listener);
    return () => ipcRenderer.removeListener("screenbot:shortcut", listener);
  },
});
