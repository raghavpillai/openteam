import { describe, expect, test } from "bun:test";
import {
  assertBoundedDocumentArchive,
  assertBoundedDocumentHtml,
  MAX_DOCUMENT_ARCHIVE_ENTRIES,
  MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES,
  MAX_DOCUMENT_PREVIEW_HTML_CHARS,
} from "../../src/renderer/components/openteam/document-preview/limits";

const syntheticZip = (expandedSizes: readonly number[]): ArrayBuffer => {
  const directorySize = expandedSizes.length * 46;
  const bytes = new Uint8Array(30 + directorySize + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  let offset = 30;
  for (const size of expandedSizes) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint32(offset + 24, size, true);
    offset += 46;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, expandedSizes.length, true);
  view.setUint16(offset + 10, expandedSizes.length, true);
  view.setUint32(offset + 12, directorySize, true);
  view.setUint32(offset + 16, 30, true);
  return bytes.buffer;
};

describe("document preview expansion limits", () => {
  test("accepts ordinary ZIP documents and non-ZIP spreadsheets", () => {
    expect(() => assertBoundedDocumentArchive(syntheticZip([1_024, 4_096]))).not.toThrow();
    expect(() =>
      assertBoundedDocumentArchive(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer)
    ).not.toThrow();
  });

  test("rejects oversized expansion, excessive entries, and malformed directories", () => {
    expect(() =>
      assertBoundedDocumentArchive(syntheticZip([MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES + 1]))
    ).toThrow("too large or complex");
    expect(() =>
      assertBoundedDocumentArchive(
        syntheticZip(Array.from({ length: MAX_DOCUMENT_ARCHIVE_ENTRIES + 1 }, () => 0))
      )
    ).toThrow("too large or complex");
    const malformed = syntheticZip([1]);
    new DataView(malformed).setUint32(30, 0, true);
    expect(() => assertBoundedDocumentArchive(malformed)).toThrow("archive is invalid");
  });

  test("bounds the worker-to-renderer HTML handoff", () => {
    expect(assertBoundedDocumentHtml("<p>Normal document</p>")).toBe("<p>Normal document</p>");
    expect(() =>
      assertBoundedDocumentHtml("x".repeat(MAX_DOCUMENT_PREVIEW_HTML_CHARS + 1))
    ).toThrow("too large or complex");
  });
});
