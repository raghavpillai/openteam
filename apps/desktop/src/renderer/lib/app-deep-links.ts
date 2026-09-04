export const SETTINGS_ANCHORS = [
  "theme",
  "local-execution",
  "computers",
  "inference-provider",
  "inference-model",
  "inference-reasoning",
  "auto-review",
  "update-status",
  "server-update",
  "automatic-updates",
] as const;

export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[number];
export type SettingsView = "general" | "computer" | "server" | "updates";
export const OPENTEAM_DEEP_LINK_EVENT = "openteam:deep-link";

const settingsAnchorSet = new Set<string>(SETTINGS_ANCHORS);

const viewByAnchor: Record<SettingsAnchor, SettingsView> = {
  theme: "general",
  "local-execution": "computer",
  computers: "computer",
  "inference-provider": "server",
  "inference-model": "server",
  "inference-reasoning": "server",
  "auto-review": "general",
  "update-status": "updates",
  "server-update": "updates",
  "automatic-updates": "updates",
};

export type OpenTeamDeepLink =
  | { kind: "settings"; anchor: SettingsAnchor }
  | { kind: "plugin"; pluginId: string }
  | { kind: "template"; template: TemplateBot };

export const settingsViewForAnchor = (anchor: SettingsAnchor): SettingsView => viewByAnchor[anchor];

export const parseOpenTeamDeepLink = (value: string): OpenTeamDeepLink | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "openteam:" || url.hostname !== "app") return null;

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
