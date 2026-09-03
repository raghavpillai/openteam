import { describe, expect, test } from "bun:test";
import { computeVirtualRange } from "../src/renderer/lib/virtual-window";
import {
  buildEmojiVirtualRows,
  emojiVirtualRowHeight,
} from "../src/renderer/components/openteam/emoji-virtual-grid";

describe("emoji grid virtualization", () => {
  test("keeps the complete corpus searchable while bounding mounted rows", () => {
    const emojis = Array.from({ length: 1_914 }, (_, index) => `emoji-${index}`);
    const rows = buildEmojiVirtualRows([{ label: "All emoji", emojis }]);
    const range = computeVirtualRange({
      count: rows.length,
      scrollOffset: 4_000,
      viewportSize: 266,
      overscan: 170,
      maxItems: 40,
      sizeAt: (index) => emojiVirtualRowHeight(rows[index]!),
    });

    expect(rows.flatMap((row) => (row.kind === "emojis" ? row.emojis : []))).toEqual(emojis);
    expect(range.endIndex - range.startIndex).toBeLessThanOrEqual(40);
    expect(range.startIndex).toBeGreaterThan(100);
  });

  test("retains category headers and an empty search result", () => {
    expect(
      buildEmojiVirtualRows([
        { label: "Smileys", emojis: ["🙂"] },
        { label: "Results", emojis: [] },
      ]).map((row) => row.kind)
    ).toEqual(["header", "emojis", "header", "empty"]);
  });
});
