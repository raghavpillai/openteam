import { describe, expect, test } from "bun:test";
import {
  createSearchRequestGate,
  readSearchCache,
  SEARCH_QUERY_MAX_LENGTH,
  searchCacheKey,
  writeSearchCache,
} from "@openbot/product-core/search";
import { normalizeMobileSearchQuery } from "../src/search";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("mobile search cache", () => {
  test("normalizes and caps pasted queries before cache and transport work", () => {
    const normalized = normalizeMobileSearchQuery(`  ＯpenBot   ${"x".repeat(500)}  `);

    expect(normalized.startsWith("OpenBot x")).toBe(true);
    expect(normalized).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    expect(normalizeMobileSearchQuery("Audit Bot 0001")).toBe("Audit Bot 0001");
  });

  test("evicts the least-recently-used query at the configured bound", () => {
    const cache = new Map<string, number>();
    writeSearchCache(cache, "first", 1, 3);
    writeSearchCache(cache, "second", 2, 3);
    writeSearchCache(cache, "third", 3, 3);
    expect(readSearchCache(cache, "first")).toBe(1);

    writeSearchCache(cache, "fourth", 4, 3);

    expect([...cache.entries()]).toEqual([
      ["third", 3],
      ["first", 1],
      ["fourth", 4],
    ]);
    expect(cache.has("second")).toBe(false);
  });

  test("replacing a key preserves the bound and promotes the new value", () => {
    const cache = new Map<string, number>([
      ["first", 1],
      ["second", 2],
    ]);
    writeSearchCache(cache, "first", 10, 2);
    expect([...cache.entries()]).toEqual([
      ["second", 2],
      ["first", 10],
    ]);
  });

  test("cursor changes reject stale in-flight results and use a distinct cache entry", async () => {
    const cache = new Map<string, string[]>();
    const gate = createSearchRequestGate();
    const firstKey = searchCacheKey("41", "all", "launch plan");
    const secondKey = searchCacheKey("42", "all", "launch plan");
    const firstToken = gate.begin(firstKey);
    const firstResponse = deferred<string[]>();
    const applyFirst = firstResponse.promise.then((results) => {
      if (gate.isCurrent(firstToken)) writeSearchCache(cache, firstKey, results);
    });

    gate.invalidate();
    const secondToken = gate.begin(secondKey);
    firstResponse.resolve(["stale"]);
    await applyFirst;

    expect(firstKey).not.toBe(secondKey);
    expect(cache.has(firstKey)).toBe(false);
    expect(gate.isCurrent(firstToken)).toBe(false);
    expect(gate.isCurrent(secondToken)).toBe(true);
    writeSearchCache(cache, secondKey, ["fresh"]);
    expect(readSearchCache(cache, secondKey)).toEqual(["fresh"]);
  });

  test("a same-key retry also supersedes a transport that resolves after abort", () => {
    const gate = createSearchRequestGate();
    const key = searchCacheKey("42", "messages", "status");
    const first = gate.begin(key);
    const retry = gate.begin(key);

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(retry)).toBe(true);
  });
});
