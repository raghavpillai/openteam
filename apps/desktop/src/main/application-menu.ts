import type { MenuItemConstructorOptions } from "electron";

export type ApplicationMenuAction = "about" | "updates" | "settings";

export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  onAction: (action: ApplicationMenuAction) => void
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
          submenu: [...appItems, { type: "separator" }, { role: "quit" }],
        },
    ...(platform === "darwin" ? [{ role: "fileMenu" } as const] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
