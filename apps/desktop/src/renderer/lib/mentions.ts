export interface MentionOption {
  id: string;
  label: string;
  handle: string;
  color?: string;
  icon?: string;
  hasAvatar?: boolean;
  updatedAt?: string;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; id: string; label: string; handle: string };

export const mentionHandleFor = (label: string): string =>
  label.trim().replace(/\s+/g, "").toLocaleLowerCase("en-US");

export const moveMentionSelection = (
  current: number,
  count: number,
  direction: -1 | 1
): number => (count > 0 ? (current + direction + count) % count : 0);

const mentionPickerHandledKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab"]);

export const shouldRefreshMentionPickerOnKeyUp = (key: string, pickerOpen: boolean): boolean =>
  key !== "Escape" && !(pickerOpen && mentionPickerHandledKeys.has(key));

export const mentionPlainText = (segments: readonly MentionSegment[]): string =>
  segments
    .map((segment) => (segment.type === "text" ? segment.text : `@${segment.handle}`))
    .join("");

export const mentionRichText = (segments: readonly MentionSegment[]): string => {
  const paragraphs: Array<{ type: "paragraph"; content?: Array<Record<string, unknown>> }> = [
    { type: "paragraph", content: [] },
  ];
  const pushText = (text: string) => {
    const paragraph = paragraphs.at(-1);
    if (!paragraph) return;
    const previous = paragraph.content?.at(-1);
    if (previous?.type === "text" && typeof previous.text === "string") {
      previous.text += text;
    } else {
      paragraph.content?.push({ type: "text", text });
    }
  };
  for (const segment of segments) {
    if (segment.type === "mention") {
      paragraphs.at(-1)?.content?.push({
        type: "mention",
        attrs: { id: segment.id, label: segment.label },
      });
      continue;
    }
    const pieces = segment.text.split("\n");
    pieces.forEach((piece, index) => {
      if (piece) pushText(piece);
      if (index < pieces.length - 1) paragraphs.push({ type: "paragraph", content: [] });
    });
  }
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((paragraph) =>
      paragraph.content?.length ? paragraph : { type: "paragraph" }
    ),
  });
};
