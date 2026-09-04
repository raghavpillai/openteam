import type { BotView } from "@openteam/contracts";

export const BOT_TEMPLATE_SHARING_ENABLED = true;
export const BOT_TEMPLATE_REQUEST =
  "Create a template of yourself that I can share with somebody else.";
export const BOT_TEMPLATE_CHANGED_EVENT = "openteam:bot-template-changed";

export type BotTemplateAudience = "team" | "public";
export type BotTemplateStatus = "draft" | "published";

export type TemplateBot = Pick<
  BotView,
  "color" | "description" | "icon" | "instructions" | "name" | "notificationsEnabled" | "title"
>;

export interface BotTemplateRecord {
  id: string;
  sourceBotId: string;
  audience: BotTemplateAudience;
  status: BotTemplateStatus;
  createdAt: string;
  updatedAt: string;
  bot: TemplateBot;
}

interface SerializedBotTemplate {
  format: "openteam.bot-template";
  version: 1;
  bot: TemplateBot;
}

const STORAGE_KEY = "openteam:bot-templates:v1";

const templatePayload = (bot: TemplateBot): SerializedBotTemplate => ({
  format: "openteam.bot-template",
  version: 1,
  bot: {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    icon: bot.icon,
    color: bot.color,
    notificationsEnabled: bot.notificationsEnabled,
  },
});

export function serializeBotTemplate(bot: TemplateBot) {
  return JSON.stringify(templatePayload(bot), null, 2);
}

const isTemplateBot = (value: unknown): value is TemplateBot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bot = value as Record<string, unknown>;
  return (
    typeof bot.name === "string" &&
    bot.name.trim().length > 0 &&
    bot.name.length <= 80 &&
    typeof bot.title === "string" &&
    bot.title.length <= 120 &&
    typeof bot.description === "string" &&
    bot.description.length <= 2_000 &&
    typeof bot.instructions === "string" &&
    bot.instructions.length <= 40_000 &&
    typeof bot.icon === "string" &&
    bot.icon.length <= 120 &&
    typeof bot.color === "string" &&
    bot.color.length <= 80 &&
    typeof bot.notificationsEnabled === "boolean"
  );
};

export function parseBotTemplate(value: string): TemplateBot | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.format === "openteam.bot-template" &&
      parsed.version === 1 &&
      isTemplateBot(parsed.bot)
      ? parsed.bot
      : null;
  } catch {
    return null;
  }
}

const base64UrlEncode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlDecode = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

export function botTemplateShareUrl(bot: TemplateBot) {
  const data = base64UrlEncode(JSON.stringify(templatePayload(bot)));
  return `openteam://app/v1/template/add?data=${data}`;
}

export function parseBotTemplateShareUrl(value: string): TemplateBot | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "openteam:" || url.hostname !== "app") return null;
    if (url.pathname !== "/v1/template/add") return null;
    const data = url.searchParams.get("data");
    if (!data || data.length > 100_000) return null;
    return parseBotTemplate(base64UrlDecode(data));
  } catch {
    return null;
  }
}

const storageAvailable = () => typeof window !== "undefined" && Boolean(window.localStorage);

const readTemplates = (): BotTemplateRecord[] => {
  if (!storageAvailable()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as BotTemplateRecord[]) : [];
  } catch {
    return [];
  }
};

const writeTemplates = (templates: BotTemplateRecord[]) => {
  if (!storageAvailable()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
};

const notifyTemplateChanged = (botId: string) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BOT_TEMPLATE_CHANGED_EVENT, { detail: { botId } }));
};

export function botTemplateFor(botId: string): BotTemplateRecord | null {
  return readTemplates().find((template) => template.sourceBotId === botId) ?? null;
}

export function createBotTemplateDraft(
  bot: TemplateBot & { id: string },
  audience: BotTemplateAudience
): BotTemplateRecord {
  const now = new Date().toISOString();
  const existing = botTemplateFor(bot.id);
  const record: BotTemplateRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    sourceBotId: bot.id,
    audience,
    status: "draft",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    bot: templatePayload(bot).bot,
  };
  writeTemplates([
    ...readTemplates().filter((template) => template.sourceBotId !== bot.id),
    record,
  ]);
  notifyTemplateChanged(bot.id);
  return record;
}

export function updateBotTemplateAudience(
  template: BotTemplateRecord,
  audience: BotTemplateAudience
): BotTemplateRecord {
  const updated = { ...template, audience, updatedAt: new Date().toISOString() };
  writeTemplates(
    readTemplates().map((candidate) => (candidate.id === template.id ? updated : candidate))
  );
  notifyTemplateChanged(template.sourceBotId);
  return updated;
}

export function publishBotTemplate(template: BotTemplateRecord): BotTemplateRecord {
  const published = {
    ...template,
    status: "published" as const,
    updatedAt: new Date().toISOString(),
  };
  writeTemplates(
    readTemplates().map((candidate) => (candidate.id === template.id ? published : candidate))
  );
  notifyTemplateChanged(template.sourceBotId);
  return published;
}

export function deleteBotTemplate(template: BotTemplateRecord) {
  writeTemplates(readTemplates().filter((candidate) => candidate.id !== template.id));
  notifyTemplateChanged(template.sourceBotId);
}

export function copyBotTemplate(bot: TemplateBot) {
  return navigator.clipboard.writeText(serializeBotTemplate(bot));
}

export function copyBotTemplateLink(template: BotTemplateRecord) {
  return navigator.clipboard.writeText(botTemplateShareUrl(template.bot));
}
