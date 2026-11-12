import type { BaseWindow, BrowserWindow, MenuItemConstructorOptions } from "electron";

export type ApplicationMenuAction = "about" | "updates" | "settings" | "appshot";
export type ClipboardMenuAction = "copy" | "cut" | "paste";

export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  onAction: (action: ApplicationMenuAction) => void,
  onClipboard?: (action: ClipboardMenuAction, window: BaseWindow | undefined) => boolean,
  /** The appshot shortcut when it's an ordinary one; a two-key chord can't show in a menu. */
  appshotAccelerator: string | null = null
): MenuItemConstructorOptions[] {
  const appItems: MenuItemConstructorOptions[] = [
    { label: "About OpenTeam", click: () => onAction("about") },
    { label: "Check for Updates…", click: () => onAction("updates") },
    { type: "separator" },
    {
      label: "Settings…",
      accelerator: "CommandOrControl+,",
      click: () => onAction("settings"),
    },
  ];
  // The global shortcut (or both-key chord) fires the appshot; the menu shows it and handles clicks.
  const appshotItem: MenuItemConstructorOptions = {
    label: "Take Appshot",
    ...(appshotAccelerator ? { accelerator: appshotAccelerator, registerAccelerator: false } : {}),
    click: () => onAction("appshot"),
  };

  return [
    platform === "darwin"
      ? {
          label: "OpenTeam",
          submenu: [
            ...appItems,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide", label: "Hide OpenTeam" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: "Quit OpenTeam" },
          ],
        }
      : {
          label: "File",
          submenu: [appshotItem, { type: "separator" }, ...appItems, { type: "separator" }, { role: "quit" }],
        },
    ...(platform === "darwin"
      ? [{ label: "File", submenu: [appshotItem, { type: "separator" }, { role: "close" }] } satisfies MenuItemConstructorOptions]
      : []),
    onClipboard ? {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        ...(["cut", "copy", "paste"] as const).map<MenuItemConstructorOptions>(action => ({
          label: action[0]!.toUpperCase() + action.slice(1),
          accelerator: `CommandOrControl+${action === "paste" ? "V" : action === "copy" ? "C" : "X"}`,
          // Chromium handles keyboard shortcuts; these callbacks handle menu clicks.
          registerAccelerator: false,
          click: (_item, window) => {
            if (!onClipboard(action, window) && window && "webContents" in window) (window as BrowserWindow).webContents[action]();
          },
        })),
        { type: "separator" }, { role: "selectAll" },
      ],
    } : { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
