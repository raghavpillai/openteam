import emojiData from "emojibase-data/en/compact.json";

const EMOJI_GROUP_SPECS = [
  { id: 0, label: "Smileys & emotion" },
  { id: 1, label: "People & body" },
  { id: 3, label: "Animals & nature" },
  { id: 4, label: "Food & drink" },
  { id: 5, label: "Travel & places" },
  { id: 6, label: "Activities" },
  { id: 7, label: "Objects" },
  { id: 8, label: "Symbols" },
  { id: 9, label: "Flags" },
] as const;

type EmojiEntry = (typeof emojiData)[number];

const EMOJI_ENTRIES = emojiData
  .filter(
    (entry): entry is EmojiEntry & { group: number } =>
      typeof entry.group === "number" && EMOJI_GROUP_SPECS.some(({ id }) => id === entry.group)
  )
  .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

const EMOJI_ENTRY_BY_GLYPH = new Map(EMOJI_ENTRIES.map((entry) => [entry.unicode, entry]));

export const EMOJI_GROUPS = EMOJI_GROUP_SPECS.map(({ id, label }) => ({
  label,
  emojis: EMOJI_ENTRIES.filter((entry) => entry.group === id).map((entry) => entry.unicode),
}));

const ALL_EMOJIS = EMOJI_ENTRIES.map((entry) => entry.unicode);

const normalizeEmojiQuery = (value: string) =>
  value.trim().toLocaleLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");

export const searchEmojis = (query: string): string[] => {
  const normalizedQuery = normalizeEmojiQuery(query);
  if (!normalizedQuery) return [...ALL_EMOJIS];
  const queryTokens = normalizedQuery.split(" ");

  return EMOJI_ENTRIES.map((entry, index) => {
    const emoticons = Array.isArray(entry.emoticon)
      ? entry.emoticon
      : entry.emoticon
        ? [entry.emoticon]
        : [];
    const terms = normalizeEmojiQuery(
      [entry.unicode, entry.label, ...(entry.tags ?? []), ...emoticons].join(" ")
    );
    const termTokens = terms.split(" ");
    if (!queryTokens.every((token) => terms.includes(token))) return null;

    const score =
      entry.unicode === normalizedQuery
        ? 0
        : termTokens.includes(normalizedQuery)
          ? 1
          : termTokens.some((term) => term.startsWith(normalizedQuery))
            ? 2
            : 3;
    return { emoji: entry.unicode, index, score };
  })
    .filter((result) => result !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ emoji }) => emoji);
};

export const emojiLabel = (emoji: string) => EMOJI_ENTRY_BY_GLYPH.get(emoji)?.label ?? emoji;
