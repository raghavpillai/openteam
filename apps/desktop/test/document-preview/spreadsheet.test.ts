import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { spreadsheetHtml } from "../../src/renderer/components/openteam/document-preview/spreadsheet-parser";

describe("spreadsheet preview data", () => {
  test("retains every workbook sheet with safe sheet names", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Quarter", "Total"],
        ["Q1", 24],
      ]),
      'Cash & "Ops"'
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Merchant"], ["Corner Coffee"]]),
      "Transactions"
    );
    const html = await spreadsheetHtml(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    expect(html).toContain('data-sheet-name="Cash &amp; &quot;Ops&quot;"');
    expect(html).toContain('data-sheet-name="Transactions"');
    expect(html).toContain("Corner Coffee");
    expect(html).toContain('data-sheet-rows="1"');
  });

  test("preserves UTF-8, quoted CSV cells, and identifiers with leading zeros", async () => {
    const bytes = new TextEncoder().encode(
      'Account,Merchant,Notes\n0042,Café,"Weekly pass, zone A"\n'
    );
    const html = await spreadsheetHtml(bytes.buffer);
    expect(html).toContain("0042");
    expect(html).toContain("Café");
    expect(html).toContain("Weekly pass, zone A");
  });

  test("bounds rendered rows while retaining the full source row count", async () => {
    const csv = [
      "Name,Value",
      ...Array.from({ length: 500 }, (_, index) => `row-${index},${index}`),
    ].join("\n");
    const html = await spreadsheetHtml(new TextEncoder().encode(csv).buffer);
    expect(html).toContain('data-sheet-rows="500"');
    expect(html).toContain("row-198");
    expect(html).not.toContain("row-199");
    expect(html).not.toContain("row-499");
  });
});
