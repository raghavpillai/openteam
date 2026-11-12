import { describe, expect, test } from "bun:test";
import { renderReadText, readLimitNotice } from "../src/read-output";

describe("message and Read boundaries", () => {
  test("Read applies the limit before line numbering and withholds oversized content", () => {
    const equal = renderReadText("a".repeat(100_000));
    expect(equal.exceededLimit).toBe(false);
    expect(equal.text).toBe(`     1|${"a".repeat(100_000)}`);
    const over = renderReadText("a".repeat(100_001));
    expect(over.exceededLimit).toBe(true);
    expect(over.text).toBe(readLimitNotice(100_001));
    expect(over.text).not.toContain("aaaa");
  });
  test("large numbers of lines produce a bounded notice rather than millions of prefixes", () => {
    const result = renderReadText("x\n".repeat(1_000_000));
    expect(result.lines).toBe(1_000_001);
    expect(result.text).toBe(readLimitNotice(2_000_000));
  });
});
