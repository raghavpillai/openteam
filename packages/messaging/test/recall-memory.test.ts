import { expect, test } from "bun:test";
import { parseRecallInput, recallMemoryResult } from "../src/recall-memory";

const fact = (content: string, day: number, scope: "agent" | "user" = "agent") => ({ content, createdAt: new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`), tier: "log", scope, via: scope === "user" ? "Teammate" : undefined });

test("recall ranks distinct lexical overlap before date and uses substring only when needed", () => {
  const candidates = [fact("alpha beta", 1), fact("alpha alpha", 9), fact("Ticket AB-7", 8)];
  const result = recallMemoryResult({ query: "alpha beta AB-7" }, candidates);
  expect(result.indexOf("alpha beta", result.indexOf("\n"))).toBeLessThan(result.lastIndexOf("alpha alpha"));
  expect(result).not.toContain("Ticket AB-7");
  expect(recallMemoryResult({ query: "ab-7" }, candidates)).toContain("Ticket AB-7");
});

test("recall defaults malformed optional fields and separates private from shared scope", () => {
  expect(parseRecallInput({ query: " test ", scope: "project", limit: 51 })).toEqual({ query: "test", scope: "all", limit: 20 });
  const candidates = [fact("shared alpha", 1, "user"), fact("private alpha", 2)];
  const result = recallMemoryResult({ query: "alpha", scope: "user" }, candidates);
  expect(result).toContain("shared via Teammate");
  expect(result).not.toContain("private alpha");
  expect(() => parseRecallInput({ query: " " })).toThrow();
});

test("recall keeps first long fact, limits later facts and preserves note markers", () => {
  const result = recallMemoryResult({ query: "alpha" }, [fact(`[note] alpha ${"x".repeat(4500)}`, 9), fact("alpha older", 1)]);
  expect(result).toContain("[log] [note] alpha");
  expect(result).toContain("1 more matches not shown");
});
