import { expect, test } from "bun:test";
import {
  buildExtractionUserPrompt,
  gatherExtractionMemories,
  holdMemoryExchange,
  isMemorableExchange,
  parseExtractedMemories,
  parseHeldMemoryExchanges,
  renderTurnMemoryDate,
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

test("the extraction prompt carries today's date and exchanges an interrupted review left", () => {
  expect(
    buildExtractionUserPrompt(
      "I moved to Lyon last month, update my address on file?",
      "Done, noted.",
      ["The user's name is Ada.", "Lives in Paris."],
      [{ user: "I start at Acme Monday.", agent: "Congrats!" }],
      "Monday, October 20, 2026 (Europe/Paris)"
    )
  ).toBe(
    [
      "Existing memory:",
      "- The user's name is Ada.",
      "- Lives in Paris.",
      "",
      "Today's date: Monday, October 20, 2026 (Europe/Paris)",
      "",
      "Earlier exchange (not yet reviewed):",
      "User: I start at Acme Monday.",
      "Assistant: Congrats!",
      "",
      "Latest exchange:",
      "User: I moved to Lyon last month, update my address on file?",
      "Assistant: Done, noted.",
    ].join("\n")
  );
  expect(renderTurnMemoryDate(new Date("2026-10-05T10:00:00Z"), "Europe/Paris")).toBe(
    "Monday Oct 5, 2026 (Europe/Paris)"
  );
  expect(renderTurnMemoryDate(new Date("2026-10-05T23:30:00Z"), "Asia/Tokyo")).toBe(
    "Tuesday Oct 6, 2026 (Asia/Tokyo)"
  );
  expect(renderTurnMemoryDate(new Date("2026-10-05T10:00:00Z"), "Not/AZone")).toBe(
    "Monday Oct 5, 2026 (UTC)"
  );
});

test("held exchanges are bounded and malformed entries are dropped", () => {
  const long = `${"a".repeat(5_000)}MIDDLE${"z".repeat(5_000)}`;
  const held = holdMemoryExchange({ id: "run-1", user: long, agent: " ok " });
  expect(held.user).toHaveLength(8_000 + "\n[...middle omitted...]\n".length);
  expect(held.user).not.toContain("MIDDLE");
  expect(held.agent).toBe("ok");
  expect(parseHeldMemoryExchanges([held, { id: 3 }, null, "x"])).toEqual([held]);
  expect(parseHeldMemoryExchanges({})).toEqual([]);
});
