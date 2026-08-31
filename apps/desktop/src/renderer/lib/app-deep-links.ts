export const SETTINGS_ANCHORS = [
  "theme",
  "language",
  "microphone",
  "hardware-acceleration",
  "hardware-acceleration-restart",
  "notification-sound-enabled",
  "notification-sound",
  "timezone",
  "local-execution",
  "computers",
  "chrome-cookie-import",
  "auto-review",
  "security-keys",
  "plan",
  "cancel-trial",
  "on-demand",
  "egress",
  "update-status",
  "update-channel",
  "automatic-updates",
  "update-computer",
  "reset-computer",
] as const;

export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[number];
export type SettingsView = "general" | "computer" | "usage" | "updates";

const settingsAnchorSet = new Set<string>(SETTINGS_ANCHORS);

const viewByAnchor: Record<SettingsAnchor, SettingsView> = {
  theme: "general",
  language: "general",
  microphone: "general",
  "hardware-acceleration": "general",
  "hardware-acceleration-restart": "general",
  "notification-sound-enabled": "general",
  "notification-sound": "general",
  timezone: "general",
  "local-execution": "computer",
  computers: "computer",
  "chrome-cookie-import": "computer",
  "auto-review": "general",
  "security-keys": "general",
  plan: "usage",
  "cancel-trial": "usage",
  "on-demand": "usage",
  egress: "usage",
  "update-status": "updates",
  "update-channel": "updates",
  "automatic-updates": "updates",
  "update-computer": "updates",
  "reset-computer": "updates",
};

export type OpenBotDeepLink =
  | { kind: "settings"; anchor: SettingsAnchor }
  | { kind: "plugin"; pluginId: string }
  | { kind: "template"; template: TemplateBot };

export const settingsViewForAnchor = (anchor: SettingsAnchor): SettingsView => viewByAnchor[anchor];

export const parseOpenBotDeepLink = (value: string): OpenBotDeepLink | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "grokbot:" || url.hostname !== "app") return null;

  const id = url.searchParams.get("id")?.trim() ?? "";
  if (url.pathname === "/v1/settings") {
    return settingsAnchorSet.has(id) ? { kind: "settings", anchor: id as SettingsAnchor } : null;
  }
  if (
    url.pathname === "/v1/plugin/add" &&
    id.length > 0 &&
    id.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(id)
  ) {
    return { kind: "plugin", pluginId: id };
  }
  if (url.pathname === "/v1/template/add") {
    const template = parseBotTemplateShareUrl(value);
    return template ? { kind: "template", template } : null;
  }
  return null;
};

import { parseBotTemplateShareUrl, type TemplateBot } from "./bot-template";
