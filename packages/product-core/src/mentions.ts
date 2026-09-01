export interface MentionOption {
  id: string;
  label: string;
  handle: string;
  color?: string;
  icon?: string;
  hasAvatar?: boolean;
  updatedAt?: string;
}

export const mentionHandleFor = (label: string): string =>
  label.trim().replace(/\s+/g, "").toLocaleLowerCase("en-US");

export const filterMentionOptions = (
  options: readonly MentionOption[],
  query: string
): MentionOption[] => {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  return normalized
    ? options.filter(
        (option) =>
          option.handle.toLocaleLowerCase("en-US").includes(normalized) ||
          option.label.toLocaleLowerCase("en-US").includes(normalized)
      )
    : [...options];
};

export const insertPlainTextMention = (
  text: string,
  matchStart: number,
  matchText: string,
  handle: string
): string => {
  const mentionOffset = matchText.lastIndexOf("@");
  const start = matchStart + Math.max(0, mentionOffset);
  return `${text.slice(0, start)}@${handle} ${text.slice(matchStart + matchText.length)}`;
};
