import { describe, expect, test } from "bun:test";
import { normalizeSearchQuery, prefixTsQuery } from "../src/services/search-service";

describe("search query parsing", () => {
  test("normalizes whitespace and creates safe prefix terms", () => {
    expect(normalizeSearchQuery("  Command   K  ")).toBe("Command K");
    expect(prefixTsQuery("Command K")).toBe("Command:* & K");
  });

  test("supports unicode words and drops tsquery punctuation", () => {
    expect(prefixTsQuery("שלום, world! & (fast)")).toBe("שלום:* & world:* & fast:*");
  });

  test("does not expand a one-character term across the full lexicon", () => {
    expect(prefixTsQuery("a command")).toBe("a & command:*");
  });
});
