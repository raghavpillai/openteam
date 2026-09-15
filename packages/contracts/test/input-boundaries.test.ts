import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { SendMessageInput, RuntimeInlineImage, ComputerSteerRequest } from "../src";
import { MAX_INLINE_IMAGE_URL_LENGTH } from "../src/media-input";
import { renderReadText, readLimitNotice } from "../src/read-output";

describe("message and Read boundaries", () => {
  test("accepts long text and rich text without unrelated composer caps", () => {
    const input = {
      content: "x".repeat(400_001),
      richText: "x".repeat(400_001),
      clientId: "input-probe-914",
    };
    expect(Schema.decodeUnknownSync(SendMessageInput)(input)).toEqual(input);
    const steer = { inboxId: "qa-inbox", clientMessageId: "qa-message", content: input.content };
    expect(Schema.decodeUnknownSync(ComputerSteerRequest)(steer)).toEqual(steer);
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
