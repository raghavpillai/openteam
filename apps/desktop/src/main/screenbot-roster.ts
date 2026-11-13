export interface ScreenBotBot {
  id: string;
  name: string;
  title: string;
  color: string;
  icon: string;
  /** The Bot's direct chat, for opening it from the sent pill. */
  channelId: string;
  avatarDataUrl?: string;
}

export interface ScreenBotRoster {
  bots: ScreenBotBot[];
  /** The server has transcription set up, so the composer can offer dictation. */
  dictation: boolean;
  /** The app's appearance setting; the overlay has its own storage and can't read it. */
  theme?: "light" | "dark" | "system";
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

/** Copy only the fields the overlay renders. The main window's renderer is trusted, but its
 * roster still crosses into another page and is stored for later ScreenBots. */
export const parseScreenBotRoster = (value: unknown): ScreenBotRoster | null => {
  if (!isRecord(value) || !Array.isArray(value.bots) || value.bots.length > 500) return null;
  const bots: ScreenBotBot[] = [];
  for (const candidate of value.bots) {
    if (!isRecord(candidate)) return null;
    const id = text(candidate.id, 200);
    const name = text(candidate.name, 200);
    const color = text(candidate.color, 40);
    const icon = text(candidate.icon, 60);
    const channelId = text(candidate.channelId, 128);
    if (!id || name === null || !color || icon === null || !channelId) return null;
    const avatar = text(candidate.avatarDataUrl, 400_000);
    bots.push({
      id,
      name,
      title: text(candidate.title, 200) ?? "",
      color,
      icon,
      channelId,
      ...(avatar?.startsWith("data:image/") ? { avatarDataUrl: avatar } : {}),
    });
  }
  const theme = value.theme === "light" || value.theme === "dark" || value.theme === "system" ? value.theme : undefined;
  return { bots, dictation: value.dictation === true, ...(theme ? { theme } : {}) };
};

