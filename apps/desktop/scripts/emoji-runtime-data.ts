export type EmojiRuntimeSource = {
  emoticon?: string | string[];
  group?: number;
  label: string;
  order?: number;
  tags?: string[];
  unicode: string;
};

/** Search treats terms as a set of normalized words. Omit repeated words from
 * build data while retaining labels, category order and every searchable term. */
export function emojiPickerRuntimeEntries(source: readonly EmojiRuntimeSource[]) {
  const normalize = (value: string) =>
    value.trim().toLocaleLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  const groups = new Set([0, 1, 3, 4, 5, 6, 7, 8, 9]);
  return source
    .filter(entry => entry.group !== undefined && groups.has(entry.group))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(({ unicode, label, group, tags, emoticon }) => {
      const emoticons = Array.isArray(emoticon) ? emoticon : emoticon ? [emoticon] : [];
      const words = new Set(normalize([unicode, label, ...emoticons].join(" ")).split(" "));
      const remaining = tags?.filter(tag => {
        const word = normalize(tag);
        if (words.has(word)) return false;
        words.add(word);
        return true;
      });
      return { unicode, label, group, tags: remaining?.length ? remaining : undefined, emoticon };
    });
}
