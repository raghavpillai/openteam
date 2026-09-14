export const READ_CHAR_LIMIT = 100_000;

export const readLimitNotice = (fileSize: number): string =>
  `File content (${fileSize} characters) exceeds maximum allowed characters (${READ_CHAR_LIMIT} characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`;

/** The limit measures selected UTF-16 content before adding line numbers. */
export const renderReadText = (
  raw: string,
  offset?: number,
  limit?: number,
  fileSize = raw.length
) => {
  let totalLines = raw.length === 0 ? 0 : 1;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) totalLines++;
  if (totalLines > 0 && offset !== undefined && offset > totalLines) {
    throw new Error(`Offset ${offset} is beyond file length (${totalLines} lines)`);
  }
  const start = Math.min(
    totalLines,
    offset === undefined
      ? 0
      : offset < 0
        ? Math.max(0, totalLines + offset)
        : Math.max(0, offset - 1)
  );
  const end = Math.min(totalLines, start + (limit ?? totalLines));
  let line = 0;
  let lineStart = 0;
  let units = 0;
  const output: string[] = [];
  for (let i = 0; i <= raw.length && line < end; i++) {
    if (i !== raw.length && raw.charCodeAt(i) !== 10) continue;
    if (line >= start) {
      // Keep the established CRLF display while measuring the actual source units.
      units += i - lineStart + (line > start ? 1 : 0);
      if (units <= READ_CHAR_LIMIT) {
        const contentEnd = i > lineStart && raw.charCodeAt(i - 1) === 13 ? i - 1 : i;
        output.push(`${line + 1}: ${raw.slice(lineStart, contentEnd)}`);
      }
    }
    line++;
    lineStart = i + 1;
  }
  const exceededLimit = units > READ_CHAR_LIMIT;
  return {
    text:
      raw.length === 0
        ? "File is empty."
        : exceededLimit
          ? readLimitNotice(fileSize)
          : output.join("\n"),
    lines: Math.max(0, end - start),
    totalLines,
    offset: start + 1,
    fileSize,
    isEmpty: raw.length === 0,
    exceededLimit,
  };
};
