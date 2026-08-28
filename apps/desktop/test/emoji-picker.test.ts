import { describe, expect, test } from "bun:test";
import { searchEmojis } from "../src/renderer/components/openbot/emoji-picker";

describe("searchEmojis", () => {
  test("matches common text emoticons", () => {
    expect(searchEmojis("XD")).toEqual(["😆"]);
  });

  test("uses the full categorized Unicode corpus", () => {
    expect(searchEmojis("").length).toBeGreaterThan(1_900);
    expect(searchEmojis("flag israel")).toEqual(["🇮🇱"]);
  });

  test("matches emoji names and related concepts", () => {
    const results = searchEmojis("heart");
    expect(results).toEqual(
      expect.arrayContaining(["😍", "🫶", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍"])
    );
  });

  test("supports multi-word keyword searches", () => {
    expect(searchEmojis("party celebrate")).toEqual(
      expect.arrayContaining(["🥳", "🎉", "🎊", "🪅"])
    );
  });

  test("returns no results for an unknown query", () => {
    expect(searchEmojis("definitely-not-an-emoji")).toEqual([]);
  });
});
