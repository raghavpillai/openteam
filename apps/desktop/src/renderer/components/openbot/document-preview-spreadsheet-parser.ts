export const spreadsheetHtml = async (buffer: ArrayBuffer) => {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array" });
  const first = workbook.SheetNames[0];
  if (!first) throw new Error("This spreadsheet is empty.");
  const sheet = workbook.Sheets[first];
  if (!sheet) throw new Error("This spreadsheet is empty.");
  const sourceRange = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const previewRange = {
    s: sourceRange.s,
    e: {
      c: Math.min(sourceRange.e.c, sourceRange.s.c + 29),
      r: Math.min(sourceRange.e.r, sourceRange.s.r + 199),
    },
  };
  return XLSX.utils.sheet_to_html({
    ...sheet,
    "!ref": XLSX.utils.encode_range(previewRange),
  });
};
