import type { SettingsAnchor } from "./app-deep-links";

export const SETTINGS_PALETTE_SECTIONS = [
  {
    id: "general",
    label: "General",
    icon: "settings",
    target: null,
    keywords: [
      "account",
      "model",
      "notifications",
      "preferences",
      "appearance",
      "theme",
      "mode",
      "security",
      "sign out",
      "logout",
      "bot defaults",
      "auto review",
    ],
  },
  {
    id: "computer",
    label: "Computer",
    icon: "computer",
    target: "computers",
    keywords: ["computer", "machines", "local execution", "host", "permissions", "run tasks"],
  },
  {
    id: "updates",
    label: "Updates",
    icon: "updates",
    target: "update-status",
    keywords: [
      "updates",
      "update",
      "reset",
      "beta",
      "release",
      "track",
      "desktop",
      "server",
      "computer",
      "version",
      "upgrade",
      "automatic",
      "ssh",
      "mismatch",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: "settings" | "computer" | "updates";
  target: SettingsAnchor | null;
  keywords: readonly string[];
}>;

export const THEME_PALETTE_COMMANDS = [
  {
    preference: "system",
    label: "System",
    icon: "theme-system",
    keywords: ["appearance", "os", "auto", "follow"],
  },
  {
    preference: "light",
    label: "Light",
    icon: "theme-light",
    keywords: ["appearance", "day", "bright"],
  },
  {
    preference: "dark",
    label: "Dark",
    icon: "theme-dark",
    keywords: ["appearance", "night", "mode"],
  },
] as const;

export const CHAT_SETTINGS_KEYWORDS = ["details", "notifications", "members", "info"] as const;
export const PLUGINS_PALETTE_KEYWORDS = [
  "plugins",
  "marketplace",
  "tools",
  "skills",
  "mcp",
  "connectors",
  "customize",
] as const;
export const HIDDEN_BOTS_PALETTE_KEYWORDS = [
  "hidden",
  "bots",
  "agents",
  "groups",
  "unhide",
] as const;
export const UPDATE_PALETTE_KEYWORDS = [
  "app",
  "check",
  "version",
  "upgrade",
  "install",
  "latest",
  "release",
  "download",
  "restart",
] as const;

export type PaletteUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "backing-up"
  | "downloaded"
  | "installing"
  | "error";

export const updatePalettePresentation = (
  status: PaletteUpdateStatus | null | undefined
): { title: string; icon: "refresh" | "updates" } => {
  switch (status) {
    case "checking":
      return { title: "Checking for Updates…", icon: "refresh" };
    case "available":
    case "downloading":
      return { title: "Downloading Update…", icon: "updates" };
    case "backing-up":
      return { title: "Preparing Update…", icon: "updates" };
    case "downloaded":
      return { title: "Restart to Update", icon: "refresh" };
    case "installing":
      return { title: "Update in Progress…", icon: "refresh" };
    default:
      return { title: "Check for Updates", icon: "refresh" };
  }
};
