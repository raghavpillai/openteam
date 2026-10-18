/** Longest message preview, in UTF-16 code units, including the trailing ellipsis. */
export const MESSAGE_PREVIEW_LIMIT = 200;
/** Markdown is only scanned this far into a line, so a huge one-line message stays cheap. */
const MARKDOWN_SCAN_LIMIT = 4096;

type Range = readonly [start: number, end: number];

const inRanges = (index: number, ranges: readonly Range[]): boolean =>
  ranges.some(([start, end]) => index >= start && index < end);

/** Cuts at `end` without splitting a surrogate pair. */
const sliceCodeUnits = (value: string, end: number): string =>
  value.slice(0, /[\uD800-\uDBFF]/.test(value[end - 1] ?? "") ? end - 1 : end);

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

const fencedCodeRanges = (text: string): Range[] => {
  const ranges: Range[] = [];
  let offset = 0;
  let fence = "";
  let fenceIndent = 0;
  let openedAt = -1;
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    const marker = match?.[1];
    const indent = match && marker !== undefined ? match[0].length - marker.length : 0;
    if (openedAt < 0) {
      const info = match ? line.slice(match[0].length) : "";
      if (marker !== undefined && (marker[0] === "~" || !info.includes("`"))) {
        fence = marker;
        fenceIndent = indent;
        openedAt = offset;
      }
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker &&
      indent <= fenceIndent + 3
    ) {
      ranges.push([openedAt, offset + line.length]);
      openedAt = -1;
    }
    offset += line.length + 1;
  }
  if (openedAt >= 0) ranges.push([openedAt, text.length]);
  return ranges;
};

const blankLineRanges = (text: string): Range[] => {
  const ranges: Range[] = [];
  let previous = -1;
  for (let next = text.indexOf("\n"); next >= 0; next = text.indexOf("\n", next + 1)) {
    if (previous >= 0 && /^[ \t]*$/.test(text.slice(previous + 1, next))) {
      ranges.push([previous, next + 1]);
    }
    previous = next;
  }
  return ranges;
};

/** Inline code spans: a backtick run closed by the next run of the same length, within one paragraph. */
const codeSpanRanges = (text: string, fenced: readonly Range[]): Range[] => {
  const runs: Range[] = [];
  for (const match of text.matchAll(/`+/g)) {
    if (!inRanges(match.index, fenced)) runs.push([match.index, match.index + match[0].length]);
  }
  const runsByLength = new Map<number, number[]>();
  runs.forEach(([start, end], index) => {
    const sameLength = runsByLength.get(end - start);
    if (sameLength) sameLength.push(index);
    else runsByLength.set(end - start, [index]);
  });
  const cursors = new Map<number, number>();
  const blankLines = blankLineRanges(text);
  let blankLine = 0;
  const spans: Range[] = [];
  for (let index = 0; index < runs.length; ) {
    const [start, end] = runs[index]!;
    const sameLength = runsByLength.get(end - start) ?? [];
    let cursor = cursors.get(end - start) ?? 0;
    while (cursor < sameLength.length && sameLength[cursor]! <= index) cursor += 1;
    cursors.set(end - start, cursor);
    while (blankLine < blankLines.length && blankLines[blankLine]![0] < end) blankLine += 1;
    const paragraphEnd = blankLines[blankLine]?.[1] ?? Number.POSITIVE_INFINITY;
    const closing = sameLength[cursor];
    if (closing === undefined || runs[closing]![0] >= paragraphEnd) {
      index += 1;
      continue;
    }
    spans.push([start, runs[closing]![1]]);
    index = closing + 1;
  }
  return spans;
};

const codeRanges = (text: string): Range[] => {
  const fenced = fencedCodeRanges(text);
  return [...fenced, ...codeSpanRanges(text, fenced)];
};

const FORMATTING_TAGS = new Set("u ins b strong i em s strike del sub sup mark br".split(" "));

/** Removes balanced formatting tags such as `<b>…</b>` and `<br>`, leaving their text. */
const stripFormattingTags = (text: string): string => {
  if (!text.includes("<")) return text;
  const code = codeRanges(text);
  const removed: Range[] = [];
  const open: Array<{ tag: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/<(\/?)([a-zA-Z]+)\s*(\/)?>/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const tag = match[2]?.toLowerCase();
    if (inRanges(start, code) || tag === undefined || !FORMATTING_TAGS.has(tag)) continue;
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    if (tag === "br") {
      if (!(closing && selfClosing)) removed.push([start, end]);
      continue;
    }
    if (selfClosing) continue;
    if (!closing) {
      open.push({ tag, start, end });
      continue;
    }
    const opener = open.at(-1);
    if (opener?.tag !== tag) continue;
    open.pop();
    removed.push([opener.start, opener.end], [start, end]);
  }
  if (removed.length === 0) return text;
  removed.sort((left, right) => left[0] - right[0]);
  let result = "";
  let offset = 0;
  for (const [start, end] of removed) {
    result += text.slice(offset, start);
    offset = end;
  }
  return result + text.slice(offset);
};

const MATH = /\$\$(?:[^$\\]|\\[\s\S])+\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
const LATEX_TEXT_COMMAND =
  /\\(?:text(?:rm|sf|tt|normal|bf|md|it|up)?|emph|(?:textcolor|colorbox)\{[^{}]*\}|fcolorbox\{[^{}]*\}\{[^{}]*\})\{([^{}]*)\}|\\color\{[^{}]*\}/g;

const unwrapLatexText = (math: string): string => {
  const unwrapped = math.replace(LATEX_TEXT_COMMAND, "$1");
  return unwrapped === math ? math : unwrapLatexText(unwrapped);
};

/** Drops `$$…$$`, `\(…\)` and `\[…\]` delimiters, keeping the expression. */
const stripMathDelimiters = (text: string): string => {
  const code = codeRanges(text);
  return text.replace(MATH, (math: string, start: number) =>
    inRanges(start, code) ? math : unwrapLatexText(math.slice(2, -2))
  );
};

const MARKDOWN_SYNTAX: ReadonlyArray<readonly [RegExp, string]> = [
  [/`+/g, ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/\\\$/g, "$"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ""],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/~~([^~]+)~~/g, "$1"],
  [/\*([^*\n]+)\*/g, "$1"],
  [/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1"],
  [/\|/g, " "],
];

/** Markdown as the plain text a reader sees, on one line. */
export const markdownToPlainText = (markdown: string): string =>
  MARKDOWN_SYNTAX.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    stripMathDelimiters(stripFormattingTags(markdown))
  )
    .replace(/\s+/g, " ")
    .trim();

export const truncatePreviewText = (value: string, limit = MESSAGE_PREVIEW_LIMIT): string =>
  value.length <= limit ? value : `${sliceCodeUnits(value, limit - 1).trimEnd()}…`;

/** The first non-empty line of a message, as plain text. */
export const messagePreviewText = (content: string, limit = MESSAGE_PREVIEW_LIMIT): string => {
  const line = content.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return truncatePreviewText(
    markdownToPlainText(
      line.length <= MARKDOWN_SCAN_LIMIT ? line : sliceCodeUnits(line, MARKDOWN_SCAN_LIMIT)
    ),
    limit
  );
};

export type AttachmentSummaryKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "table"
  | "json"
  | "text"
  | "document"
  | "archive"
  | "file";

const ATTACHMENT_NOUNS: Record<AttachmentSummaryKind, readonly [one: string, other: string]> = {
  image: ["image", "images"],
  video: ["video", "videos"],
  audio: ["audio file", "audio files"],
  pdf: ["PDF", "PDFs"],
  markdown: ["Markdown file", "Markdown files"],
  table: ["spreadsheet", "spreadsheets"],
  json: ["JSON file", "JSON files"],
  text: ["text file", "text files"],
  document: ["document", "documents"],
  archive: ["archive", "archives"],
  file: ["file", "files"],
};

const SPREADSHEET_TYPES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const DOCUMENT_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

const kindFromMimeType = (mimeType: string): AttachmentSummaryKind | null => {
  const type = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (SPREADSHEET_TYPES.has(type)) return "table";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (DOCUMENT_TYPES.has(type)) return "document";
  if (ARCHIVE_TYPES.has(type)) return "archive";
  return type.startsWith("text/") ? "text" : null;
};

const EXTENSIONS: Partial<Record<AttachmentSummaryKind, string>> = {
  image: "avif bmp gif ico jpeg jpg png svg webp heic heif",
  video: "m4v mov mp4 ogv webm",
  audio: "aac flac m4a mp3 oga ogg opus wav weba",
  pdf: "pdf",
  table: "csv tsv xlsx xls",
  json: "json jsonc json5 ndjson",
  markdown: "md markdown mdx",
  document: "docx",
  archive: "zip tar gz tgz bz2 tbz2 xz txz zst 7z rar",
  text:
    "html htm txt text log rst adoc tex xml yaml yml toml ini cfg conf env properties plist " +
    "gradle css scss sass less js jsx mjs cjs ts tsx mts cts py pyi rb go rs java kt kts c h cc " +
    "cpp cxx hpp hh cs php swift scala dart lua pl pm r sql graphql gql proto vue svelte astro " +
    "sh bash zsh fish bat ps1 tf tfvars dockerfile diff patch",
};
const EXTENSION_KINDS = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.split(" ").map((extension) => [extension, kind as AttachmentSummaryKind] as const)
  )
);

const kindFromPath = (path: string): AttachmentSummaryKind | null => {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {}
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const name = pathname.split(/[/\\]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXTENSION_KINDS.get(name.slice(dot + 1).toLowerCase()) ?? null;
};

export interface AttachmentSummarySource {
  mimeType?: string | null;
  fileName?: string | null;
  url?: string | null;
}

export const attachmentSummaryKind = (attachment: AttachmentSummarySource): AttachmentSummaryKind =>
  (attachment.mimeType ? kindFromMimeType(attachment.mimeType) : null) ??
  (attachment.fileName ? kindFromPath(attachment.fileName) : null) ??
  (attachment.url ? kindFromPath(attachment.url) : null) ??
  "file";

const countedNoun = (kind: AttachmentSummaryKind, count: number): string =>
  `${count} ${ATTACHMENT_NOUNS[kind][count === 1 ? 0 : 1]}`;

/** "Sent 1 image", or "Sent 3 files · 2 images, 1 PDF" for a mix. */
export const attachmentsPreviewText = (attachments: readonly AttachmentSummarySource[]): string => {
  const counts = new Map<AttachmentSummaryKind, number>();
  for (const attachment of attachments) {
    const kind = attachmentSummaryKind(attachment);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const total = Math.max(1, attachments.length);
  const [only] = counts.keys();
  if (counts.size <= 1) return `Sent ${countedNoun(only ?? "file", total)}`;
  const breakdown = [...counts].map(([kind, count]) => countedNoun(kind, count)).join(", ");
  return `Sent ${countedNoun("file", total)} · ${breakdown}`;
};
