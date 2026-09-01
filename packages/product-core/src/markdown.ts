const MARKDOWN_SYNTAX_PATTERN =
  /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*(?=$|\n))|\[[^\]]+\]\([^)]+\)|(?:^|[\s([{])(?:\*{1,2}|_{1,2}|~{2})(?=\S)|`/;

/** Platform-neutral fast path used before loading either client's rich renderer. */
export const messageContainsMarkdownSyntax = (content: string): boolean =>
  MARKDOWN_SYNTAX_PATTERN.test(content);

export interface CommonMarkdownFeatures {
  table: boolean;
  math: boolean;
  mermaid: boolean;
}

export const commonMarkdownFeatures = (content: string): CommonMarkdownFeatures => ({
  table: /(?:^|\n)\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/.test(content),
  math: /(?:^|\n)\s*\$\$|\$(?!\$)[^\n$]+\$(?!\$)/.test(content),
  mermaid: /(?:```|~~~)\s*mermaid\b/i.test(content),
});

export const messageNeedsAdvancedMarkdown = (content: string): boolean => {
  const features = commonMarkdownFeatures(content);
  return features.table || features.math || features.mermaid;
};
