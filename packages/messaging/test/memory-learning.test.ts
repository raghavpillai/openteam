import { expect, test } from "bun:test";
import {
  buildExtractionUserPrompt,
  gatherExtractionMemories,
  isMemorableExchange,
  parseExtractedMemories,
} from "../src/memory-learning";

test("extraction lines add, retire and prefix facts, skipping ones already known", () => {
  expect(
    parseExtractedMemories(
      [
        "remove: Lives in Boston.",
        "profile: Lives in NYC.",
        "- note: Likes cobalt for the demo.",
        "log: Lives in Boston.",
        "An untagged line is history.",
        "NONE",
      ].join("\n"),
      ["Lives in Boston."]
    )
  ).toEqual({
    additions: [
      { content: "Lives in NYC.", kind: "profile" },
      { content: "[note] Likes cobalt for the demo.", kind: "log" },
      { content: "An untagged line is history.", kind: "log" },
    ],
    removals: ["Lives in Boston."],
  });
  expect(parseExtractedMemories("  NONE \n", [])).toEqual({ additions: [], removals: [] });
});

test("the learner sees in-prompt facts first, then a few older ones that share words", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);
  const facts = [
    { content: "Old profile fact.", tier: "profile", createdAt: day(0), importance: 1 },
    { content: "Newer profile fact.", tier: "profile", createdAt: day(5), importance: 1 },
    ...Array.from({ length: 31 }, (_, i) => ({
      content: `Journal entry ${i}.`,
      tier: "log",
      createdAt: day(10 + i),
      importance: 1,
    })),
  ];
  const gathered = gatherExtractionMemories(facts, "What was in journal entry 0?");
  expect(gathered.slice(0, 2)).toEqual(["Newer profile fact.", "Old profile fact."]);
  expect(gathered.slice(2, 32)).toEqual(
    Array.from({ length: 30 }, (_, i) => `Journal entry ${30 - i}.`)
  );
  // The oldest entry fell out of the recent slice but shares "journal" and "entry".
  expect(gathered.slice(32)).toEqual(["Journal entry 0."]);
});

test("small talk is skipped, anything substantive is reviewed", () => {
  expect(isMemorableExchange("thanks!")).toBe(false);
  expect(isMemorableExchange("ok")).toBe(false);
  expect(isMemorableExchange("ok?")).toBe(true);
  expect(isMemorableExchange("I moved to Lyon")).toBe(true);
});

test("an empty exchange still renders the extraction prompt shape", () => {
  expect(buildExtractionUserPrompt("", "", [])).toBe(
    "Existing memory:\n(empty)\n\nLatest exchange:\nUser: (no message)\nAssistant: (no message)"
  );
});
