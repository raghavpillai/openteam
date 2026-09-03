import type { SearchCategory, SearchResultKind } from "@openteam/contracts";
import {
  normalizeSearchQuery,
  SEARCH_CATEGORIES,
  searchTextMatches,
} from "@openteam/product-core/search";

export type SearchSection = SearchCategory | "actions";

export const SEARCH_SECTIONS: ReadonlyArray<{ id: SearchSection; label: string }> = [
  ...SEARCH_CATEGORIES.map(({ category, label }) => ({
    id: category,
    label: category === "channels" ? "Groups" : label,
  })),
  { id: "actions", label: "Actions" },
];

export const isDefaultSearchResultKind = (kind: SearchResultKind) =>
  kind === "bot" || kind === "channel";

export const searchSectionDirectionForKey = ({
  key,
  query,
  shiftKey = false,
}: {
  key: string;
  query: string;
  shiftKey?: boolean;
}): -1 | 1 | null => {
  if (key === "Tab") return shiftKey ? -1 : 1;
  if (query.length > 0) return null;
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return null;
};

export const moveSearchSection = (current: SearchSection, direction: -1 | 1): SearchSection => {
  const index = SEARCH_SECTIONS.findIndex((section) => section.id === current);
  return (
    SEARCH_SECTIONS[(index + direction + SEARCH_SECTIONS.length) % SEARCH_SECTIONS.length]?.id ??
    "all"
  );
};

export const moveSearchSelection = (current: number, count: number, direction: -1 | 1) => {
  if (count === 0) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
};

export const normalizeClientSearch = (value: string) =>
  normalizeSearchQuery(value, { lowercase: true });

export { searchTextMatches };

const COMBINING_MARKS = /\p{M}+/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const MAX_FUZZY_SPAN_MULTIPLIER = 3;

interface NormalizedPaletteText {
  normalized: string;
  sourceIndices: number[];
}

/** Match Grok Bot's command-palette normalization, including accent and punctuation folding. */
const normalizePaletteTextWithIndices = (value: string): NormalizedPaletteText => {
  let normalized = "";
  const sourceIndices: number[] = [];
  let pendingSeparator = false;

  for (let index = 0; index < value.length; index += 1) {
    const folded = value
      .charAt(index)
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .toLocaleLowerCase()
      .replaceAll("ς", "σ")
      .replaceAll("ı", "i");

    for (const character of folded) {
      if (!LETTER_OR_NUMBER.test(character)) {
        pendingSeparator = true;
        continue;
      }
      if (pendingSeparator && normalized.length > 0) {
        normalized += " ";
        sourceIndices.push(-1);
      }
      pendingSeparator = false;
      normalized += character;
      sourceIndices.push(index);
    }
  }

  return { normalized, sourceIndices };
};

export const normalizePaletteText = (value: string): string =>
  normalizePaletteTextWithIndices(value).normalized;

const paletteQueryTokens = (query: string): string[] => {
  const normalized = normalizePaletteText(query);
  return normalized ? normalized.split(" ") : [];
};

/** Score a compact subsequence with bonuses for word starts and consecutive characters. */
export const fuzzyPaletteScore = (field: string, token: string): number | null => {
  if (token.length === 0) return 0;
  const comparableField = field.toLowerCase();
  let score = 0;
  let tokenIndex = 0;
  let previousMatch = -2;
  let firstMatch = -1;
  let lastMatch = -1;

  for (
    let fieldIndex = 0;
    fieldIndex < comparableField.length && tokenIndex < token.length;
    fieldIndex += 1
  ) {
    if (comparableField[fieldIndex] !== token[tokenIndex]) continue;
    if (firstMatch < 0) firstMatch = fieldIndex;
    const previousCharacter = field.charAt(fieldIndex - 1);
    const startsWord = fieldIndex === 0 || [" ", "-", "_", "/", "."].includes(previousCharacter);
    const startsCamelCaseWord =
      previousCharacter >= "a" &&
      previousCharacter <= "z" &&
      field.charAt(fieldIndex) >= "A" &&
      field.charAt(fieldIndex) <= "Z";
    let characterScore = 1;
    if (startsWord || startsCamelCaseWord) characterScore += 4;
    if (previousMatch === fieldIndex - 1) characterScore += 3;
    score += characterScore;
    previousMatch = fieldIndex;
    lastMatch = fieldIndex;
    tokenIndex += 1;
  }

  if (
    tokenIndex < token.length ||
    lastMatch - firstMatch + 1 > token.length * MAX_FUZZY_SPAN_MULTIPLIER
  ) {
    return null;
  }
  return score - firstMatch * 0.1 - comparableField.length * 0.02;
};

export interface PaletteSearchItem {
  title: string;
  keywords?: readonly string[];
  searchPriority?: number;
}

export const scorePaletteItem = (query: string, item: PaletteSearchItem): number | null => {
  const tokens = paletteQueryTokens(query);
  if (tokens.length === 0) return 0;
  const normalizedQuery = tokens.join(" ");
  const normalizedTitle = normalizePaletteText(item.title);
  const fields = [normalizedTitle, ...(item.keywords ?? []).map(normalizePaletteText)];
  let score = 0;

  for (const token of tokens) {
    let bestFieldScore: number | null = null;
    for (const field of fields) {
      const fieldScore = fuzzyPaletteScore(field, token);
      if (fieldScore !== null && (bestFieldScore === null || fieldScore > bestFieldScore)) {
        bestFieldScore = fieldScore;
      }
    }
    if (bestFieldScore === null) return null;
    score += bestFieldScore;
  }

  return score + (fuzzyPaletteScore(normalizedTitle, normalizedQuery) ?? 0);
};

export const rankPaletteItems = <Item extends PaletteSearchItem>(
  items: readonly Item[],
  query: string
): Item[] => {
  if (paletteQueryTokens(query).length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: scorePaletteItem(query, item) }))
    .filter(
      (candidate): candidate is { item: Item; index: number; score: number } =>
        candidate.score !== null
    )
    .sort(
      (left, right) =>
        (left.item.searchPriority ?? 1) - (right.item.searchPriority ?? 1) ||
        right.score - left.score ||
        left.index - right.index
    )
    .map(({ item }) => item);
};

export interface PaletteHighlightSegment {
  text: string;
  isMatch: boolean;
  start: number;
}

/** Highlight only literal normalized token occurrences in the visible label. */
export const paletteHighlightSegments = (
  label: string,
  query: string
): PaletteHighlightSegment[] => {
  const tokens = paletteQueryTokens(query);
  if (tokens.length === 0 || label.length === 0) {
    return [{ text: label, isMatch: false, start: 0 }];
  }
  const { normalized, sourceIndices } = normalizePaletteTextWithIndices(label);
  const matches = new Array<boolean>(label.length).fill(false);

  for (const token of tokens) {
    let fromIndex = 0;
    while (fromIndex <= normalized.length - token.length) {
      const matchIndex = normalized.indexOf(token, fromIndex);
      if (matchIndex < 0) break;
      for (let offset = 0; offset < token.length; offset += 1) {
        const sourceIndex = sourceIndices[matchIndex + offset];
        if (sourceIndex !== undefined && sourceIndex >= 0) matches[sourceIndex] = true;
      }
      fromIndex = matchIndex + token.length;
    }
  }

  const segments: PaletteHighlightSegment[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const isMatch = matches[index] ?? false;
    const previous = segments.at(-1);
    if (previous?.isMatch === isMatch) previous.text += label[index] ?? "";
    else segments.push({ text: label[index] ?? "", isMatch, start: index });
  }
  return segments;
};

export const searchTimeLabel = (value: string) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
};
