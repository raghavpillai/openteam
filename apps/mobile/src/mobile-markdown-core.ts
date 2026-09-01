import {
  commonMarkdownFeatures,
  messageContainsMarkdownSyntax,
  messageNeedsAdvancedMarkdown,
} from "@openbot/product-core/markdown";

export const MOBILE_MARKDOWN_RICH_CHARACTER_LIMIT = 32_000;
export const MOBILE_MARKDOWN_RICH_LINE_LIMIT = 240;
export const MOBILE_MARKDOWN_RICH_MARKER_LIMIT = 600;
export const MOBILE_MARKDOWN_PLAIN_PREVIEW_CHARACTER_LIMIT = 2_000;
export const MOBILE_MARKDOWN_PLAIN_PREVIEW_LINE_LIMIT = 16;
export const MOBILE_ACCESSIBILITY_SUMMARY_CHARACTER_LIMIT = 400;
export const MOBILE_ACCESSIBILITY_SUMMARY_LINE_LIMIT = 4;
const MOBILE_MARKDOWN_INLINE_TOKEN_LIMIT = 256;

export const messageNeedsMobileMarkdown = (content: string): boolean =>
  messageContainsMarkdownSyntax(content) || messageNeedsAdvancedMobileMarkdown(content);

export const messageNeedsAdvancedMobileMarkdown = messageNeedsAdvancedMarkdown;

/** Tables render natively so chat-cell height remains deterministic on iOS. */
export const messageNeedsDomMobileMarkdown = (content: string): boolean => {
  const features = commonMarkdownFeatures(content);
  return features.math || features.mermaid;
};

/**
 * One chat cell must never expand a valid, very large message into thousands of
 * native views. Content outside these rendering bounds uses a bounded plain-text
 * preview; the full source remains available from the message Copy action.
 */
export const shouldRenderRichMobileMarkdown = (content: string): boolean => {
  if (content.length > MOBILE_MARKDOWN_RICH_CHARACTER_LIMIT) return false;
  let lines = 1;
  let markers = 0;
  for (const character of content) {
    if (character === "\n") {
      lines += 1;
      if (lines > MOBILE_MARKDOWN_RICH_LINE_LIMIT) return false;
      continue;
    }
    if (
      character === "*" ||
      character === "_" ||
      character === "~" ||
      character === "`" ||
      character === "["
    ) {
      markers += 1;
      if (markers > MOBILE_MARKDOWN_RICH_MARKER_LIMIT) return false;
    }
  }
  return true;
};

export const boundedMobileMarkdownPreview = (
  content: string
): { text: string; truncated: boolean } => {
  let end = Math.min(content.length, MOBILE_MARKDOWN_PLAIN_PREVIEW_CHARACTER_LIMIT);
  let lines = 1;
  for (let index = 0; index < end; index += 1) {
    if (content[index] !== "\n") continue;
    lines += 1;
    if (lines > MOBILE_MARKDOWN_PLAIN_PREVIEW_LINE_LIMIT) {
      end = index;
      break;
    }
  }
  // Avoid leaving half of a UTF-16 surrogate pair at the preview boundary.
  if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end -= 1;
  return {
    text: content.slice(0, end).trimEnd(),
    truncated: end < content.length,
  };
};

export const boundedMobileAccessibilitySummary = (content: string): string => {
  let end = Math.min(content.length, MOBILE_ACCESSIBILITY_SUMMARY_CHARACTER_LIMIT);
  let lines = 1;
  for (let index = 0; index < end; index += 1) {
    if (content[index] !== "\n") continue;
    lines += 1;
    if (lines > MOBILE_ACCESSIBILITY_SUMMARY_LINE_LIMIT) {
      end = index;
      break;
    }
  }
  if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end -= 1;
  const summary = content.slice(0, end).trimEnd();
  return end < content.length ? `${summary}…` : summary;
};

export interface MarkdownListItem {
  key: string;
  text: string;
}

export type MarkdownBlock =
  | { key: string; type: "paragraph"; text: string }
  | { key: string; type: "heading"; level: number; text: string }
  | { key: string; type: "quote"; text: string }
  | { key: string; type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { key: string; type: "code"; language: string; text: string }
  | {
      key: string;
      type: "table";
      headers: MarkdownListItem[];
      rows: MarkdownListItem[][];
    }
  | { key: string; type: "rule" };

const tableCells = (line: string): string[] | null => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const source = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      current += character;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim().replace(/\\\|/g, "|"));
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  cells.push(current.trim().replace(/\\\|/g, "|"));
  return cells.length > 1 ? cells : null;
};

const isTableDivider = (cells: string[] | null): cells is string[] =>
  Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim())));

const blockStart = (line: string): boolean =>
  /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);

export const parseMobileMarkdown = (content: string): MarkdownBlock[] => {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const blockLine = index;
    const headers = tableCells(line);
    const divider = tableCells(lines[index + 1] ?? "");
    if (headers && isTableDivider(divider) && headers.length === divider.length) {
      const rows: MarkdownListItem[][] = [];
      index += 2;
      while (index < lines.length) {
        const cells = tableCells(lines[index] ?? "");
        if (!cells) break;
        rows.push(
          headers.map((_, cellIndex) => ({
            key: `cell:${index}:${cellIndex}`,
            text: cells[cellIndex] ?? "",
          }))
        );
        index += 1;
      }
      blocks.push({
        key: `block:${blockLine}`,
        type: "table",
        headers: headers.map((text, cellIndex) => ({
          key: `header:${blockLine}:${cellIndex}`,
          text,
        })),
        rows,
      });
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*([^\s]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      const fenceMarker = fence[1] ?? "```";
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim() !== fenceMarker) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        key: `block:${blockLine}`,
        type: "code",
        language: fence[2] ?? "",
        text: body.join("\n"),
      });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        key: `block:${blockLine}`,
        type: "heading",
        level: (heading[1] ?? "#").length,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ key: `block:${blockLine}`, type: "rule" });
      index += 1;
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ key: `block:${blockLine}`, type: "quote", text: quoted.join("\n") });
      continue;
    }
    const bullet = line.match(/^\s*([-*+])\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || ordered) {
      const items: MarkdownListItem[] = [];
      const isOrdered = Boolean(ordered);
      const matcher = isOrdered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(matcher);
        if (!match?.[1]) break;
        items.push({ key: `line:${index}`, text: match[1] });
        index += 1;
      }
      blocks.push({ key: `block:${blockLine}`, type: "list", ordered: isOrdered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !blockStart(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ key: `block:${blockLine}`, type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
};

const INLINE_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\n]+\))/g;

const safeUrl = (value: string): string | null =>
  /^(?:https?:\/\/|mailto:)/i.test(value.trim()) ? value.trim() : null;

export type InlineMarkdownToken =
  | { key: string; type: "text"; text: string }
  | { key: string; type: "code" | "strong" | "strike" | "emphasis"; text: string }
  | { key: string; type: "link"; text: string; url: string };

const styledInlineToken = (token: string, offset: number): InlineMarkdownToken => {
  if (token.startsWith("`") && token.endsWith("`")) {
    return { key: `inline:${offset}`, type: "code", text: token.slice(1, -1) };
  }
  if (
    (token.startsWith("**") && token.endsWith("**")) ||
    (token.startsWith("__") && token.endsWith("__"))
  ) {
    return { key: `inline:${offset}`, type: "strong", text: token.slice(2, -2) };
  }
  if (token.startsWith("~~") && token.endsWith("~~")) {
    return { key: `inline:${offset}`, type: "strike", text: token.slice(2, -2) };
  }
  if (
    (token.startsWith("*") && token.endsWith("*")) ||
    (token.startsWith("_") && token.endsWith("_"))
  ) {
    return { key: `inline:${offset}`, type: "emphasis", text: token.slice(1, -1) };
  }
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  const url = link?.[2] ? safeUrl(link[2]) : null;
  return link?.[1] && url
    ? { key: `inline:${offset}`, type: "link", text: link[1], url }
    : { key: `inline:${offset}`, type: "text", text: token };
};

export const parseInlineMarkdown = (text: string): InlineMarkdownToken[] => {
  const tokens: InlineMarkdownToken[] = [];
  let cursor = 0;
  let styledTokens = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const offset = match.index;
    const token = match[0];
    if (offset > cursor) {
      tokens.push({ key: `text:${cursor}`, type: "text", text: text.slice(cursor, offset) });
    }
    tokens.push(styledInlineToken(token, offset));
    styledTokens += 1;
    if (styledTokens > MOBILE_MARKDOWN_INLINE_TOKEN_LIMIT) {
      return [{ key: "text:0", type: "text", text }];
    }
    cursor = offset + token.length;
  }
  if (cursor < text.length) {
    tokens.push({ key: `text:${cursor}`, type: "text", text: text.slice(cursor) });
  }
  return tokens.length > 0 ? tokens : [{ key: "text:0", type: "text", text }];
};
