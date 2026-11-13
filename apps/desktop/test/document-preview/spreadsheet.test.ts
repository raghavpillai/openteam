import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { spreadsheetHtml } from "../../src/renderer/components/openteam/document-preview/spreadsheet-parser";

describe("spreadsheet preview data", () => {
  test("retains every workbook sheet with escaped sheet names", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Quarter", "Total"], ["Q1", 24]]), 'Cash & "Ops"');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Merchant"], ["Corner Coffee"]]), "Transactions");
    const html = await spreadsheetHtml(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    expect(html).toContain('data-sheet-name="Cash &amp; &quot;Ops&quot;"');
    expect(html).toContain('data-sheet-name="Transactions"');
    expect(html).toContain("Corner Coffee");
  });

  test("keeps CSV text and leading zeros, and bounds rendered rows while counting them all", async () => {
    const csv = ["Account,Notes", '0042,"Café, zone A"', ...Array.from({ length: 499 }, (_, index) => `row-${index},${index}`)].join("\n");
    const html = await spreadsheetHtml(new TextEncoder().encode(csv).buffer);
    expect(html).toContain("0042");
    expect(html).toContain("Café, zone A");
    expect(html).toContain('data-sheet-rows="500"');
    expect(html).toContain("row-197");
    expect(html).not.toContain("row-198");
  });
});
