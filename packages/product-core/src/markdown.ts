const MARKDOWN_SYNTAX_PATTERN =
  /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*(?=$|\n))|\[[^\]]+\]\([^)]+\)|(?:^|[\s([{])(?:\*{1,2}|_{1,2}|~{2})(?=\S)|`/;

// A GFM table is a row containing a pipe followed by a delimiter row of dashes.
// Bots often send a plain sentence plus a table, with no other Markdown syntax.
const MARKDOWN_TABLE_PATTERN =
  /(?:^|\n)[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?=\n|$)/;

/** Platform-neutral fast path used before loading either client's rich renderer. */
export const messageContainsMarkdownSyntax = (content: string): boolean =>
  MARKDOWN_SYNTAX_PATTERN.test(content) || MARKDOWN_TABLE_PATTERN.test(content);
