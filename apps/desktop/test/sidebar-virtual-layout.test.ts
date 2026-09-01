import { describe, expect, test } from "bun:test";
import { computeVirtualRange } from "../src/renderer/lib/virtual-window";
import {
  chunkPinnedRows,
  estimateSidebarSectionSize,
  EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
  EXPANDED_SIDEBAR_OVERSCAN,
  pinnedGridColumnCount,
  shouldVirtualizeExpandedSidebar,
  SIDEBAR_CHANNEL_ROW_SIZE,
  SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS,
  SIDEBAR_PINNED_GRID_ROW_SIZE,
} from "../src/renderer/lib/sidebar-virtual-layout";

describe("expanded sidebar virtual layout", () => {
  test("preserves exact pinned order across responsive grid rows", () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `bot-${index}`);
    expect(pinnedGridColumnCount(269)).toBe(2);
    expect(pinnedGridColumnCount(384)).toBe(4);

    const chunks = chunkPinnedRows(ids, pinnedGridColumnCount(269));
    expect(chunks).toHaveLength(500);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks[0]).toEqual(["bot-0", "bot-1"]);
    expect(chunks.at(-1)).toEqual(["bot-998", "bot-999"]);
  });

  test("bounds pinned and custom-section windows at ten-thousand-bot scale", () => {
    const pinned = computeVirtualRange({
      count: 5_000,
      scrollOffset: 275_000,
      viewportSize: 900,
      overscan: EXPANDED_SIDEBAR_OVERSCAN,
      maxItems: EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
      sizeAt: () => SIDEBAR_PINNED_GRID_ROW_SIZE,
    });
    const sectionRows = computeVirtualRange({
      count: 10_000,
      scrollOffset: 290_000,
      viewportSize: 900,
      overscan: EXPANDED_SIDEBAR_OVERSCAN,
      maxItems: EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
      sizeAt: () => SIDEBAR_CHANNEL_ROW_SIZE,
    });

    expect(pinned.endIndex - pinned.startIndex).toBeLessThanOrEqual(
      SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS
    );
    expect(sectionRows.endIndex - sectionRows.startIndex).toBeLessThanOrEqual(48);
  });

  test("keeps collapsed, empty, and populated section geometry stable", () => {
    expect(estimateSidebarSectionSize({ id: "closed", collapsed: true }, 10_000)).toBe(40);
    expect(estimateSidebarSectionSize({ id: "empty", collapsed: false }, 0)).toBe(72);
    expect(estimateSidebarSectionSize({ id: "work", collapsed: false }, 2)).toBe(160);
    expect(shouldVirtualizeExpandedSidebar(180, 0)).toBe(false);
    expect(shouldVirtualizeExpandedSidebar(180, 1)).toBe(true);
    expect(shouldVirtualizeExpandedSidebar(0, 181)).toBe(true);
  });
});
