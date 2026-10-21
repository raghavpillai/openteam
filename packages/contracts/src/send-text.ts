// The reference's SendToUser text repair: escaped line breaks and quotes outside code
// become real ones, while Windows paths and \name mentions are left alone.
const ESCAPED_LINE_BREAK_TOKEN = /\\r\\n|\\n|\\r/g;
const ESCAPED_LINE_BREAK_RUN = /(?<!\\)(?:\\r\\n|\\n|\\r)+/g;
const ESCAPED_QUOTE = /(?<!\\)\\"/g;
const BLOCK_START = /^[\t ]*(?:[-*+] |\d{1,3}[.)] |#{1,6} |>|```|~~~)/;
const WINDOWS_PATH_TOKEN = /(?:^|\W)[A-Za-z]:\\|\\(?![nr"\\]|u[\dA-Fa-f]{4})[\w$.~-]/;
const PATH_SEGMENT_START = /^[a-z\d_$.~-]/;
const INLINE_MENTION_END = /^(?:$|[\s,.;:!?)]|[a-z\d_$.~-])/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/;
const INLINE_CODE = /(?<!`)(`{1,2})(?!`).*?(?<!`)\1(?!`)/g;
const WHITESPACE = /\s/;

function isFenceOpener(marker: string, info: string): boolean {
  if (/\\[nr]/.test(info)) return false;
  return !(marker.startsWith("`") && info.includes("`"));
}

function codeRanges(content: string): Array<[number, number]> {
  const fences: Array<[number, number]> = [];
  let open: { marker: string; start: number } | undefined;
  let lineStart = 0;
  for (const line of content.split("\n")) {
    const lineEnd = lineStart + line.length;
    const fence = FENCE_LINE.exec(line);
    if (fence != null) {
      const [, marker = "", info = ""] = fence;
      if (open == null) {
        if (isFenceOpener(marker, info)) open = { marker, start: lineStart };
      } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info.trim().length === 0) {
        fences.push([open.start, lineEnd]);
        open = undefined;
      }
    }
    lineStart = lineEnd + 1;
  }
  if (open != null) fences.push([open.start, content.length]);
  const ranges: Array<[number, number]> = [];
  let proseStart = 0;
  for (const fence of [...fences, [content.length, content.length] as [number, number]]) {
    for (const span of content.slice(proseStart, fence[0]).matchAll(INLINE_CODE)) {
      const start = proseStart + span.index!;
      ranges.push([start, start + span[0].length]);
    }
    if (fence[1] > fence[0]) ranges.push(fence);
    proseStart = fence[1];
  }
  return ranges;
}

function replaceOutsideCode(content: string, pattern: RegExp, replace: (match: string, offset: number) => string): string {
  const ranges = codeRanges(content);
  return content.replace(pattern, (match: string, offset: number) =>
    ranges.some(([start, end]) => offset >= start && offset < end) ? match : replace(match, offset)
  );
}

function isEscapeMentionOrWindowsPathSegment(content: string, start: number, end: number): boolean {
  let tokenStart = start;
  while (tokenStart > 0 && !WHITESPACE.test(content[tokenStart - 1] ?? "")) tokenStart -= 1;
  let tokenEnd = end;
  while (tokenEnd < content.length && !WHITESPACE.test(content[tokenEnd] ?? "")) tokenEnd += 1;
  const after = content.slice(end);
  if (WINDOWS_PATH_TOKEN.test(content.slice(tokenStart, tokenEnd)) && PATH_SEGMENT_START.test(after)) return true;
  const previous = content[start - 1];
  if (previous === undefined || WHITESPACE.test(previous)) return INLINE_MENTION_END.test(after);
  return (previous === '"' || previous === "'") && /^["'\\]/.test(after);
}

export function normalizeSendMessageTextContent(content: string): string {
  const withLineBreaks = replaceOutsideCode(content, ESCAPED_LINE_BREAK_RUN, (run, offset) => {
    const end = offset + run.length;
    const isLineBreak =
      run.match(ESCAPED_LINE_BREAK_TOKEN)?.length !== 1 ||
      BLOCK_START.test(content.slice(end)) ||
      !isEscapeMentionOrWindowsPathSegment(content, offset, end);
    return isLineBreak ? run.replace(ESCAPED_LINE_BREAK_TOKEN, "\n") : run;
  });
  return replaceOutsideCode(withLineBreaks, ESCAPED_QUOTE, () => '"');
}
