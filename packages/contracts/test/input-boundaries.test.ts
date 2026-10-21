import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { SendMessageInput, RuntimeInlineImage, UpdateBotInput } from "../src";
import { MAX_INLINE_IMAGE_URL_LENGTH } from "../src/media-input";
import { renderReadText, renderPdfReadText, pdfPagesText, readLimitNotice } from "../src/read-output";

describe("message and Read boundaries", () => {
  test("PDF reads render the whole text with the reference page markers and no header", () => {
    const raw = Array.from({ length: 1000 }, (_, i) => `paragraph ${i + 1} ${"text ".repeat(10)}`).join("\n") + "\n\f";
    const whole = renderPdfReadText(raw, undefined, undefined, 2858365);
    expect(whole.exceededLimit).toBe(false);
    expect(whole.lines).toBe(1004);
    expect(whole.text.startsWith("     1|paragraph 1 ")).toBe(true);
    expect(whole.text.endsWith("  1000|paragraph 1000 text text text text text text text text text text \n  1001|\n  1002|-- 1 of 1 --\n  1003|\n  1004|")).toBe(true);
    expect(renderPdfReadText(raw, 201, 1).text).toBe("... 200 lines not shown ...\n   201|paragraph 201 text text text text text text text text text text \n... 803 lines not shown ...");
    // Oracle: the reference's pdf-parse 2.4.5 (pdfjs 5.4.296) output for the same three-page PDF.
    expect(pdfPagesText("Page one line A\nPage one line B\n\n\fPage two only line\n\n\fThird page first\nThird page second\nThird page third\n\n\f"))
      .toBe("Page one line A\nPage one line B\n\n-- 1 of 3 --\n\nPage two only line\n\n-- 2 of 3 --\n\nThird page first\nThird page second\nThird page third\n\n-- 3 of 3 --\n\n");
    // Without a text layer only the page markers remain, rendered like any text; there is no OCR note.
    expect(pdfPagesText("\f\f")).toBe("\n\n-- 1 of 2 --\n\n\n\n-- 2 of 2 --\n\n");
    expect(renderPdfReadText("\f").text).toBe("     1|\n     2|\n     3|-- 1 of 1 --\n     4|\n     5|");
    expect(pdfPagesText("CRLF text\r\n\f")).toBe("CRLF text\n\n-- 1 of 1 --\n\n");
    const large = renderPdfReadText(`${"x".repeat(100_001)}\n\f`, undefined, undefined, 9);
    expect(large.exceededLimit).toBe(true);
    expect(large.text).toBe(readLimitNotice(9));
  });
  test("bot names reject whitespace without rejecting Unicode or partial edits", () => {
    const decode = Schema.decodeUnknownSync(UpdateBotInput);
    for (const name of ["", "   ", "\t\n", "\u00a0\u2003"]) {
      expect(() => decode({ name })).toThrow();
    }
    expect(decode({ name: "  東京  " })).toEqual({ name: "  東京  " });
    expect(decode({ description: "" })).toEqual({ description: "" });
  });
  test("accepts long text and rich text without unrelated composer caps", () => {
    const input = {
      content: "x".repeat(400_001),
      richText: "x".repeat(400_001),
      clientId: "input-probe-914",
    };
    expect(Schema.decodeUnknownSync(SendMessageInput)(input)).toEqual(input);
    expect(() =>
      Schema.decodeUnknownSync(SendMessageInput)({ content: "  ", clientId: input.clientId })
    ).toThrow();
  });
  test("image transport permits the base64 encoding of a full 25 MiB upload", () => {
    const url = `data:image/png;base64,${"A".repeat(Math.ceil(26_214_400 / 3) * 4)}`;
    expect(url.length).toBeLessThanOrEqual(MAX_INLINE_IMAGE_URL_LENGTH);
    expect(Schema.decodeUnknownSync(RuntimeInlineImage)({ url }).url.length).toBe(url.length);
  });
  test("Read applies the limit before line numbering and withholds oversized content", () => {
    const equal = renderReadText("a".repeat(100_000));
    expect(equal.exceededLimit).toBe(false);
    expect(equal.text).toBe(`     1|${"a".repeat(100_000)}`);
    const over = renderReadText("a".repeat(100_001));
    expect(over.exceededLimit).toBe(true);
    expect(over.text).toBe(readLimitNotice(100_001));
    expect(over.text).not.toContain("aaaa");
  });
  test("paging reads a small selection even when the whole file exceeds the limit", () => {
    const raw = `BEGIN\n${"x".repeat(100_001)}\nEND`;
    expect(renderReadText(raw, 1, 1).text).toBe("     1|BEGIN\n... 2 lines not shown ...");
    expect(renderReadText(raw, -1, 1).text).toBe("... 2 lines not shown ...\n     3|END");
    expect(renderReadText(raw, 2, 1).exceededLimit).toBe(true);
    expect(() => renderReadText(raw, 99, 1)).toThrow("Offset 99 is beyond file length (3 lines)");
    expect(renderReadText("", 1, 3)).toMatchObject({
      text: "File is empty.",
      isEmpty: true,
      totalLines: 0,
    });
  });
  test("limit notices report the file's size in bytes, in the reference wording", () => {
    expect(renderReadText("a".repeat(100001), undefined, undefined, 2858365).text).toBe(
      "Requested content exceeds maximum allowed characters (100000 characters). The file is 2858365 bytes.\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content."
    );
  });
  test("a single hidden line is singular", () => {
    expect(renderReadText("one\ntwo\nthree", 2, 1).text).toBe("... 1 line not shown ...\n     2|two\n... 1 line not shown ...");
  });
  test("measures UTF-16 units rather than UTF-8 bytes or code points", () => {
    expect(renderReadText("😀".repeat(50_000)).exceededLimit).toBe(false);
    expect(renderReadText("😀".repeat(50_001)).exceededLimit).toBe(true);
    expect(renderReadText("雪".repeat(100_000), undefined, undefined, 300_000).exceededLimit).toBe(
      false
    );
  });
  test("large numbers of lines produce a bounded notice rather than millions of prefixes", () => {
    const result = renderReadText("x\n".repeat(1_000_000));
    expect(result.lines).toBe(1_000_001);
    expect(result.text).toBe(readLimitNotice(2_000_000));
  });
});
