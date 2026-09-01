import { describe, expect, test } from "bun:test";
import {
  isDefaultSearchResultKind,
  moveSearchSection,
  moveSearchSelection,
  searchSectionDirectionForKey,
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

  test("Tab cycles sections without moving focus away from search", () => {
    expect(searchSectionDirectionForKey({ key: "Tab", query: "settings" })).toBe(1);
    expect(searchSectionDirectionForKey({ key: "Tab", query: "settings", shiftKey: true })).toBe(
      -1
    );
  });

  test("left and right only change sections when the query is empty", () => {
    expect(searchSectionDirectionForKey({ key: "ArrowLeft", query: "" })).toBe(-1);
    expect(searchSectionDirectionForKey({ key: "ArrowRight", query: "" })).toBe(1);
    expect(searchSectionDirectionForKey({ key: "ArrowLeft", query: "theme" })).toBeNull();
    expect(searchSectionDirectionForKey({ key: "ArrowRight", query: "theme" })).toBeNull();
  });

  test("the unfiltered All section starts with bots and groups", () => {
    expect(isDefaultSearchResultKind("bot")).toBe(true);
    expect(isDefaultSearchResultKind("channel")).toBe(true);
    expect(isDefaultSearchResultKind("message")).toBe(false);
    expect(isDefaultSearchResultKind("file")).toBe(false);
    expect(isDefaultSearchResultKind("link")).toBe(false);
    expect(isDefaultSearchResultKind("routine")).toBe(false);
  });
});

describe("local action matching", () => {
  test("matches every query term without depending on order", () => {
    expect(searchTextMatches("bot new", "Create a new bot", "New Bot")).toBe(true);
    expect(searchTextMatches("channel settings", "Chat settings")).toBe(false);
  });
});
