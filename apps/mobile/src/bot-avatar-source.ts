import type { BotView } from "@openteam/contracts";

/** The caller supplies only the session scoped to this server. */
export const botAvatarSource = (
  serverUrl: string,
  bot: Pick<BotView, "id" | "hasAvatar" | "updatedAt"> | undefined,
  token: string | null
): { uri: string; headers?: Record<string, string> } | null => {
  if (!serverUrl || !bot?.hasAvatar) return null;
  const uri = `${serverUrl.replace(/\/+$/, "")}/api/v0/bots/${encodeURIComponent(bot.id)}/avatar?v=${encodeURIComponent(bot.updatedAt)}`;
  return { uri, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
};
