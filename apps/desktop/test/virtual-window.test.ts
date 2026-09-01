import { describe, expect, test } from "bun:test";
import { nextHistoryPageLoadStartedAt } from "../src/renderer/lib/history-pagination";
import {
  computeVirtualRange,
  isVirtualScopeVisible,
  preservePrependScrollOffset,
  scrollTopForAnchoredItem,
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

  test("restores an item by identity when prepend and newer-edge eviction keep count flat", () => {
    const previousKeys = Array.from({ length: 10 }, (_, index) => `message-${index}`);
    const nextKeys = ["message--2", "message--1", ...previousKeys.slice(0, 8)];
    const anchorKey = "message-4";
    const nextIndex = nextKeys.indexOf(anchorKey);
    // The key moved from index 4 to index 6 after two older rows arrived and
    // two newer rows were evicted. Its top stays 20px below the viewport.
    expect(nextKeys).toHaveLength(previousKeys.length);
    expect(nextIndex).toBe(6);
    expect(
      scrollTopForAnchoredItem({
        itemStart: nextIndex * 50,
        viewportOffset: 20,
        maxScrollTop: 1_000,
      })
    ).toBe(280);
  });

  test("restores an item when append and older-edge eviction move its index backward", () => {
    const previousKeys = Array.from({ length: 10 }, (_, index) => `message-${index}`);
    const nextKeys = [...previousKeys.slice(2), "message-10", "message-11"];
    const anchorKey = "message-4";
    const nextIndex = nextKeys.indexOf(anchorKey);
    // The key moved from index 4 to index 2 after two older rows were evicted.
    expect(nextKeys).toHaveLength(previousKeys.length);
    expect(nextIndex).toBe(2);
    expect(
      scrollTopForAnchoredItem({
        itemStart: nextIndex * 50,
        scopeOrigin: 32,
        viewportOffset: -10,
        maxScrollTop: 1_000,
      })
    ).toBe(142);
  });

  test("clamps an anchored restoration to the scrollport bounds", () => {
    expect(
      scrollTopForAnchoredItem({
        itemStart: 900,
        viewportOffset: 10,
        maxScrollTop: 640,
      })
    ).toBe(640);
    expect(
      scrollTopForAnchoredItem({
        itemStart: 10,
        viewportOffset: 40,
        maxScrollTop: 640,
      })
    ).toBe(0);
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
