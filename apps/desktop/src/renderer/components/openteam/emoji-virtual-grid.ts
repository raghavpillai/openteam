export const EMOJI_GRID_HEADER_HEIGHT = 32;
export const EMOJI_GRID_ROW_HEIGHT = 34;
export const EMOJI_GRID_EMPTY_HEIGHT = 48;

export type EmojiVirtualRow =
  | { key: string; kind: "header"; label: string }
  | { emojis: string[]; key: string; kind: "emojis"; label: string }
  | { key: string; kind: "empty"; label: string };

export const buildEmojiVirtualRows = (
  groups: ReadonlyArray<{ label: string; emojis: readonly string[] }>,
  columns = 8
): EmojiVirtualRow[] => {
  const rows: EmojiVirtualRow[] = [];
  for (const group of groups) {
    rows.push({ key: `${group.label}:header`, kind: "header", label: group.label });
    if (group.emojis.length === 0) {
      rows.push({ key: `${group.label}:empty`, kind: "empty", label: group.label });
      continue;
    }
    for (let offset = 0; offset < group.emojis.length; offset += columns) {
      rows.push({
        emojis: group.emojis.slice(offset, offset + columns),
        key: `${group.label}:${offset}`,
        kind: "emojis",
        label: group.label,
      });
    }
  }
  return rows;
};

export const emojiVirtualRowHeight = (row: EmojiVirtualRow): number => {
  if (row.kind === "header") return EMOJI_GRID_HEADER_HEIGHT;
  if (row.kind === "empty") return EMOJI_GRID_EMPTY_HEIGHT;
  return EMOJI_GRID_ROW_HEIGHT;
};
