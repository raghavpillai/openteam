export const MOBILE_VIRTUAL_LIST_TUNING = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 10,
  updateCellsBatchingPeriod: 32,
  windowSize: 7,
} as const;

export const BOT_ROSTER_SEARCH_THRESHOLD = 12;

export interface SearchableBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
}

const normalizeRosterCopy = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");

export const filterBotRoster = <T extends SearchableBot>(
  bots: readonly T[],
  queryValue: string
): T[] => {
  const query = normalizeRosterCopy(queryValue).slice(0, 120);
  if (!query) return [...bots];
  const terms = query.split(" ").filter(Boolean).slice(0, 8);
  return bots.filter((bot) => {
    const searchable = normalizeRosterCopy(
      `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`
    );
    return terms.every((term) => searchable.includes(term));
  });
};

export const rowsByChannelId = <T extends { channel: { id: string } }>(
  rows: readonly T[]
): ReadonlyMap<string, T> => new Map(rows.map((row) => [row.channel.id, row]));

export const selectPinnedRows = <T extends { channel: { id: string } }>(
  rows: readonly T[],
  pinnedIds: readonly string[]
): T[] => {
  const byId = rowsByChannelId(rows);
  return pinnedIds.flatMap((channelId) => {
    const row = byId.get(channelId);
    return row ? [row] : [];
  });
};
