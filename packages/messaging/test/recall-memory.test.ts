import { expect, test } from "bun:test";
import { parseRecallInput, recallMemoryResult } from "../src/recall-memory";

const fact = (content: string, day: number, scope: "agent" | "user" = "agent", tier = "log") => ({
  content,
  createdAt: new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`),
  tier,
  scope,
  via: scope === "user" ? "Career Bot" : undefined,
});

test("recall ranks distinct lexical overlap before date and uses substring only when needed", () => {
  const candidates = [fact("alpha beta", 1), fact("alpha alpha", 9), fact("Ticket AB-7", 8)];
  const result = recallMemoryResult({ query: "alpha beta AB-7" }, candidates);
  expect(result.indexOf("alpha beta", result.indexOf("\n"))).toBeLessThan(result.lastIndexOf("alpha alpha"));
  expect(result).not.toContain("Ticket AB-7");
  expect(recallMemoryResult({ query: "ab-7" }, candidates)).toContain("Ticket AB-7");
});

test("recall searches everything, labels each fact by memory type, and ignores a scope", () => {
  expect(parseRecallInput({ query: " test ", scope: "user", limit: 51 })).toEqual({ query: "test", limit: 20 });
  expect(() => parseRecallInput({ query: " " })).toThrow();
  const candidates = [
    fact("Beta launch moved to Oct 30.", 15),
    fact("Beta launch owner is Ben.", 12, "agent", "profile"),
    fact("Prefers beta features off by default.", 1, "user"),
    fact("Beta testers are in Lyon.", 2, "user", "profile"),
  ];
  expect(recallMemoryResult({ query: "beta launch", scope: "agent" }, candidates)).toBe(
    [
      'Top 4 matches for "beta launch" in your memory and the shared user memory (4 facts searched):',
      "- (2026-09-15) [journal] Beta launch moved to Oct 30.",
      "- (2026-09-12) [profile] Beta launch owner is Ben.",
      "- (2026-09-02) [shared_profile via Career Bot] Beta testers are in Lyon.",
      "- (2026-09-01) [shared_journal via Career Bot] Prefers beta features off by default.",
    ].join("\n")
  );
  expect(recallMemoryResult({ query: "zzz" }, candidates)).toBe(
    'No facts in your memory and the shared user memory match "zzz" (4 searched). Try different words, or a shorter literal fragment.'
  );
});

test("recall keeps the first long fact, limits later facts and preserves note markers", () => {
  const result = recallMemoryResult({ query: "alpha" }, [fact(`[note] alpha ${"x".repeat(4500)}`, 9), fact("alpha older", 1)]);
  expect(result).toContain("[journal] [note] alpha");
  expect(result).toEndWith("(1 more matches not shown. Narrow the query.)");
});
