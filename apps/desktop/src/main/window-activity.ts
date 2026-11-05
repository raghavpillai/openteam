import type { BrowserWindow } from "electron";

type WindowState = Pick<BrowserWindow, "isVisible" | "isMinimized" | "isFocused">;
export const windowIsVisible = (window: WindowState) => window.isVisible() && !window.isMinimized();
export const windowIsActive = (window: WindowState) => windowIsVisible(window) && window.isFocused();

/** Keep decorative work separate from the visibility used for live notifications. */
export function bindWindowActivity(window: BrowserWindow) {
  // Retain the emitter: BrowserWindow.webContents cannot be read after closed.
  const webContents = window.webContents;
  const publishActivity = () => webContents.send("openteam:window-activity-changed", windowIsActive(window));
  const publishVisibility = () => webContents.send("openteam:window-visibility-changed", windowIsVisible(window));
  window.on("show", publishActivity);
  window.on("hide", publishActivity);
  window.on("minimize", publishActivity);
  window.on("restore", publishActivity);
  window.on("focus", publishActivity);
  window.on("blur", publishActivity);
  webContents.on("did-finish-load", publishActivity);
  window.on("show", publishVisibility);
  window.on("hide", publishVisibility);
  window.on("minimize", publishVisibility);
  window.on("restore", publishVisibility);
  webContents.on("did-finish-load", publishVisibility);
  return () => {
    window.off("show", publishActivity);
    window.off("hide", publishActivity);
    window.off("minimize", publishActivity);
    window.off("restore", publishActivity);
    window.off("focus", publishActivity);
    window.off("blur", publishActivity);
    webContents.off("did-finish-load", publishActivity);
    window.off("show", publishVisibility);
    window.off("hide", publishVisibility);
    window.off("minimize", publishVisibility);
    window.off("restore", publishVisibility);
    webContents.off("did-finish-load", publishVisibility);
  };
}
