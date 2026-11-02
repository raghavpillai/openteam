export const READ_CHAR_LIMIT = 100_000;

export const readLimitNotice = (fileSize: number): string =>
  `Requested content exceeds maximum allowed characters (${READ_CHAR_LIMIT} characters). The file is ${fileSize} bytes.\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`;

/** Zero-based [start, end) line window for a 1-based (or negative, from the end) offset. */
export const readLineWindow = (totalLines: number, offset?: number, limit?: number) => {
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
  return { start, end: Math.min(totalLines, start + (limit ?? totalLines)) };
};

const hiddenLines = (count: number) => `... ${count} ${count === 1 ? "line" : "lines"} not shown ...`;

/** Numbers the lines of a window as they arrive, so a streamed file renders like an in-memory one.
 * The limit measures selected UTF-16 content before adding line numbers. */
export class ReadWindowText {
  private units = 0;
  private readonly output: string[] = [];
  constructor(private readonly start: number) {}

  /** `line` excludes its "\n" but keeps a trailing "\r". Returns false once over the limit. */
  push(index: number, line: string): boolean {
    this.units += line.length + (index > this.start ? 1 : 0);
    // Keep the established CRLF display while measuring the actual source units.
    if (this.units <= READ_CHAR_LIMIT)
      this.output.push(`${String(index + 1).padStart(6)}|${line.endsWith("\r") ? line.slice(0, -1) : line}`);
    return this.units <= READ_CHAR_LIMIT;
  }

  render(totalLines: number, end: number, fileSize: number, isEmpty = totalLines === 0) {
    const exceededLimit = this.units > READ_CHAR_LIMIT;
    if (this.start > 0) this.output.unshift(hiddenLines(this.start));
    if (end < totalLines) this.output.push(hiddenLines(totalLines - end));
    return {
      text: isEmpty ? "File is empty." : exceededLimit ? readLimitNotice(fileSize) : this.output.join("\n"),
      lines: Math.max(0, end - this.start),
      totalLines,
      offset: this.start + 1,
      fileSize,
      isEmpty,
      exceededLimit,
    };
  }
}

export const renderReadText = (
  raw: string,
  offset?: number,
  limit?: number,
  fileSize = raw.length
) => {
  let totalLines = raw.length === 0 ? 0 : 1;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) totalLines++;
  const { start, end } = readLineWindow(totalLines, offset, limit);
  const window = new ReadWindowText(start);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i <= raw.length && line < end; i++) {
    if (i !== raw.length && raw.charCodeAt(i) !== 10) continue;
    if (line >= start && !window.push(line, raw.slice(lineStart, i))) break;
    line++;
    lineStart = i + 1;
  }
  return window.render(totalLines, end, fileSize, raw.length === 0);
};

const NOTEBOOK_OUTPUT_CHARS_PER_CELL = 2_000;
const joinedText = (value: unknown): string | undefined =>
  typeof value === "string" ? value
    : Array.isArray(value) && value.some((item) => typeof item === "string")
      ? value.filter((item): item is string => typeof item === "string").join("")
      : undefined;
const notebookOutputText = (output: unknown): string | undefined => {
  if (!output || typeof output !== "object") return;
  const value = output as { output_type?: unknown; traceback?: unknown; data?: Record<string, unknown>; text?: unknown };
  if (value.output_type === "error" && Array.isArray(value.traceback))
    return value.traceback.map((line) => String(line).replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
  if ((value.output_type === "execute_result" || value.output_type === "display_data") && value.data && typeof value.data === "object")
    return joinedText(value.data["text/plain"]) ?? joinedText(value.data["text/markdown"]);
  return joinedText(value.text);
};

/** The reference's notebook rendering: each cell's source and text output, no line numbers.
 * Undefined when the file is not a valid notebook. */
export const formatNotebookForModel = (raw: string): string | undefined => {
  let notebook: { cells?: unknown };
  try { notebook = JSON.parse(raw); } catch { return; }
  if (!notebook || typeof notebook !== "object" || !Array.isArray(notebook.cells)) return;
  const cells = notebook.cells.map((cell: { source?: unknown; outputs?: unknown }, index) => {
    const parts = [`\nCell ${index}:\n\`\`\`\n${joinedText(cell?.source) ?? ""}\`\`\``];
    let output = "";
    for (const item of Array.isArray(cell?.outputs) ? cell.outputs : []) {
      if (output.length >= NOTEBOOK_OUTPUT_CHARS_PER_CELL) break;
      const text = notebookOutputText(item);
      if (!text) continue;
      if (output.length > 0 && !output.endsWith("\n")) output += "\n";
      output += text;
    }
    if (output.length > 0) {
      const truncated = output.length > NOTEBOOK_OUTPUT_CHARS_PER_CELL;
      parts.push(`Cell ${index} output${truncated ? ` (truncated at ${NOTEBOOK_OUTPUT_CHARS_PER_CELL} chars)` : ""}:\n\`\`\`\n${output.slice(0, NOTEBOOK_OUTPUT_CHARS_PER_CELL)}\`\`\``);
    }
    return parts.join("\n\n");
  });
  return cells.length ? `${cells.join("\n\n")}\n\n` : "Notebook is empty (0 cells)";
};

/** pdftotext ends each page with a form feed. The reference's pdf-parse ends each page's text with
 * `\n\n-- N of M --\n\n`, so a Read shows which page a line is on. */
export const pdfPagesText = (raw: string): string => {
  if (!raw) return raw;
  const pages = raw.replace(/\r\n?/g, "\n").split("\f");
  if (pages.length > 1 && pages.at(-1) === "") pages.pop();
  return pages.map((page, index) => `${page.replace(/\n+$/, "")}\n\n-- ${index + 1} of ${pages.length} --\n\n`).join("");
};

/** Like the reference, a PDF's text renders like any other file: no default limit and no header. */
export const renderPdfReadText = (raw: string, offset?: number, limit?: number, fileSize = raw.length) =>
  renderReadText(pdfPagesText(raw), offset, limit, fileSize);
