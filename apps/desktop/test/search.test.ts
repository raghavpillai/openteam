import { describe, expect, test } from "bun:test";
import {
  moveSearchSection,
  moveSearchSelection,
  searchTextMatches,
} from "../src/renderer/lib/search";

describe("search keyboard navigation", () => {
  test("sections wrap in both directions", () => {
    expect(moveSearchSection("all", -1)).toBe("actions");
    expect(moveSearchSection("actions", 1)).toBe("all");
    expect(moveSearchSection("messages", 1)).toBe("bots");
  });

  test("results wrap and handle an empty list", () => {
    expect(moveSearchSelection(0, 4, -1)).toBe(3);
    expect(moveSearchSelection(3, 4, 1)).toBe(0);
    expect(moveSearchSelection(-1, 4, 1)).toBe(0);
    expect(moveSearchSelection(0, 0, 1)).toBe(-1);
  });
});

describe("local action matching", () => {
  test("matches every query term without depending on order", () => {
    expect(searchTextMatches("bot new", "Create a new bot", "New Bot")).toBe(true);
    expect(searchTextMatches("channel settings", "Chat settings")).toBe(false);
  });
});
