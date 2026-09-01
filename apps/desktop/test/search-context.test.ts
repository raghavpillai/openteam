import { describe, expect, test } from "bun:test";
import { addContextGaps } from "../src/renderer/lib/search-context";

describe("bounded search context", () => {
  const entry = (id: string, minute: number, context: boolean) => ({
    id,
    type: "message" as const,
    createdAt: `2026-08-29T12:${String(minute).padStart(2, "0")}:00.000Z`,
    context,
  });

  test("makes a distant search window visibly discontinuous from the latest tail", () => {
    const result = addContextGaps(
      [entry("old-1", 1, true), entry("old-2", 2, true), entry("latest", 59, false)],
      (candidate) => candidate.context
    );
    expect(result.map((candidate) => candidate.type)).toEqual([
      "message",
      "message",
      "context_gap",
      "message",
    ]);
  });

  test("adds no separator to one contiguous segment", () => {
    const result = addContextGaps(
      [entry("one", 1, false), entry("two", 2, false)],
      (candidate) => candidate.context
    );
    expect(result).toHaveLength(2);
  });
});
