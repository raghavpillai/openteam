export const spreadsheetHtml = async (buffer: ArrayBuffer) => {
  const XLSX = await import("xlsx");
  // Binary workbooks (XLSX zip, legacy XLS) are read as-is. Text formats such as CSV
  // are decoded as UTF-8 first, so non-ASCII cells survive without SheetJS codepage tables.
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const binary = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);
  const workbook = binary
    ? XLSX.read(buffer, { type: "array", raw: true })
    : XLSX.read(new TextDecoder().decode(buffer), { type: "string", raw: true });
  const first = workbook.SheetNames[0];
  if (!first) throw new Error("This spreadsheet is empty.");
  const sheet = workbook.Sheets[first];
  if (!sheet) throw new Error("This spreadsheet is empty.");
  const escapeAttribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return workbook.SheetNames.slice(0, 32)
    .map((name) => {
      const sheet = workbook.Sheets[name];
      if (!sheet) return "";
      const sourceRange = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
      const previewRange = {
        s: sourceRange.s,
        e: {
          c: Math.min(sourceRange.e.c, sourceRange.s.c + 29),
          r: Math.min(sourceRange.e.r, sourceRange.s.r + 199),
        },
      };
      const html = XLSX.utils.sheet_to_html({
        ...sheet,
        "!ref": XLSX.utils.encode_range(previewRange),
      });
      const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? "";
      return `<section data-sheet-name="${escapeAttribute(name)}" data-sheet-rows="${Math.max(0, sourceRange.e.r - sourceRange.s.r)}">${table}</section>`;
    })
    .join("");
};
