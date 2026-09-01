import { describe, expect, test } from "bun:test";
import { nextHistoryPageLoadStartedAt } from "../src/renderer/lib/history-pagination";
import {
  computeVirtualRange,
  isVirtualScopeVisible,
  preservePrependScrollOffset,
} from "../src/renderer/lib/virtual-window";

describe("bounded virtual windows", () => {
  test("keeps a ten-thousand-row transcript under the configured DOM ceiling", () => {
    const range = computeVirtualRange({
      count: 10_000,
      scrollOffset: 360_000,
      viewportSize: 900,
      overscan: 900,
      maxItems: 120,
      sizeAt: () => 72,
    });

    expect(range.totalSize).toBe(720_000);
    expect(range.endIndex - range.startIndex).toBeLessThanOrEqual(120);
    expect(range.startIndex).toBeGreaterThan(4_900);
    expect(range.endIndex).toBeLessThan(5_100);
  });

  test("covers variable measured heights at the beginning and end", () => {
    const sizes = [24, 240, 48, 96];
    const first = computeVirtualRange({
      count: sizes.length,
      scrollOffset: 0,
      viewportSize: 40,
      overscan: 0,
      maxItems: 10,
      sizeAt: (index) => sizes[index]!,
    });
    const last = computeVirtualRange({
      count: sizes.length,
      scrollOffset: Number.POSITIVE_INFINITY,
      viewportSize: 40,
      overscan: 0,
      maxItems: 10,
      sizeAt: (index) => sizes[index]!,
    });

    expect([first.startIndex, first.endIndex]).toEqual([0, 2]);
    expect([last.startIndex, last.endIndex]).toEqual([3, 4]);
  });

  test("keeps the same content anchored when older rows are prepended", () => {
    expect(preservePrependScrollOffset(240, 1_200, 1_920)).toBe(960);
    expect(preservePrependScrollOffset(240, 1_200, 1_100)).toBe(240);
  });

  test("does not turn a manual history load's anchor correction into a second page", () => {
    const manualStartedAt = nextHistoryPageLoadStartedAt({
      now: 1_000,
      lastStartedAt: null,
    });
    expect(manualStartedAt).toBe(1_000);
    if (manualStartedAt === null) throw new Error("manual history loads must be recorded");
    expect(
      nextHistoryPageLoadStartedAt({
        now: 1_671,
        lastStartedAt: manualStartedAt,
      })
    ).toBeNull();
    expect(
      nextHistoryPageLoadStartedAt({
        now: 1_751,
        lastStartedAt: manualStartedAt,
      })
    ).toBe(1_751);
  });

  test("suspends nested groups outside a shared scrollport", () => {
    expect(
      isVirtualScopeVisible({
        scrollOffset: -1_400,
        viewportSize: 900,
        totalSize: 11_600,
        overscan: 232,
      })
    ).toBe(false);
    expect(
      isVirtualScopeVisible({
        scrollOffset: -1_100,
        viewportSize: 900,
        totalSize: 11_600,
        overscan: 232,
      })
    ).toBe(true);
    expect(
      isVirtualScopeVisible({
        scrollOffset: 12_000,
        viewportSize: 900,
        totalSize: 11_600,
        overscan: 232,
      })
    ).toBe(false);
  });
});
