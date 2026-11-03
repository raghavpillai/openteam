import { describe, expect, test } from "bun:test";
import {
  fileGlyphVariant,
  formatAttachmentSize,
  imageRowWidth,
  planImageRow,
} from "../src/renderer/components/openteam/attachment-visuals";

// Sizes measured in the reference app's chat column (728 wide) on 2026-11-02.
describe("photo rows", () => {
  const column = imageRowWidth(728);

  test("a single photo stands at the full row height", () => {
    expect(planImageRow([{ width: 800, height: 534 }], column)).toEqual({ height: 192, widths: [288], foldedCount: 0 });
  });

  test("twenty photos fold to three tiles counting the rest on the last", () => {
    const plan = planImageRow(Array.from({ length: 20 }, () => ({ width: 640, height: 480 })), column);
    expect(plan).toEqual({ height: 136, widths: [181, 181, 181], foldedCount: 18 });
  });

  test("eight wide photos fold the same way", () => {
    const plan = planImageRow(Array.from({ length: 8 }, () => ({ width: 800, height: 531 })), column);
    expect(plan.widths).toHaveLength(3);
    expect(plan.height).toBe(121);
    expect(plan.foldedCount).toBe(6);
  });

  test("photos that fit share the row unfolded, and small ones keep their own height", () => {
    expect(planImageRow([{ width: 100, height: 100 }, { width: 100, height: 100 }], column)).toEqual({
      height: 100, widths: [100, 100], foldedCount: 0,
    });
  });

  test("a photo without a size is laid out as 4:3", () => {
    expect(planImageRow([undefined], column)).toEqual({ height: 192, widths: [256], foldedCount: 0 });
  });
});

test("sizes read like the reference's", () => {
  expect(formatAttachmentSize(658)).toBe("658B");
  expect(formatAttachmentSize(75_481)).toBe("74kB");
  expect(formatAttachmentSize(1_258_291)).toBe("1.2MB");
});

test("a file's icon comes from its name; nameless files are unknown", () => {
  expect(fileGlyphVariant("DockSchedule.pdf")).toBe("pdf");
  expect(fileGlyphVariant("1089646")).toBe("unknown");
  expect(fileGlyphVariant("Budget.xlsx")).toBe("spreadsheet");
  expect(fileGlyphVariant("Deck.key")).toBe("keynote");
});
