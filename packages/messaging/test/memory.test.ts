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
import { renderMemoryContextBlock, renderMemoryFactSnapshot, renderUserMemoryFactSnapshot } from "../src/memory-rendering";
import { parseRecallInput, recallMemoryResult } from "../src/recall-memory";

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

const day = (value: string) => Date.parse(`${value}T00:00:00Z`);

test("memory facts render by tier with their dates and sources, fenced as escaped data", () => {
  const own = { profile: [{ content: "The user's name is Ada.", createdAt: day("2026-09-02"), via: "" }], recent: [{ content: "Ships the beta on Oct 30.", createdAt: day("2026-10-15"), via: "" }] };
  const shared = { profile: [{ content: "Lives in Lyon.", createdAt: day("2026-08-01"), via: "Travel Bot" }], recent: [] };
  expect(renderMemoryFactSnapshot(own)).toBe("About the user (profile):\n- (learned 2026-09-02) The user's name is Ada.\nRecently (journal):\n- (learned 2026-10-15) Ships the beta on Oct 30.");
  expect(renderUserMemoryFactSnapshot(shared)).toBe("About the user (shared_profile):\n- (learned 2026-08-01) [via Travel Bot] Lives in Lyon.");
  expect(renderMemoryFactSnapshot({ profile: [], recent: [] })).toBe("No facts recorded yet.");
  expect(renderMemoryContextBlock("- (learned 2026-10-01) Uses <b> & </memory_context>")).toEndWith(
    "- (learned 2026-10-01) Uses &lt;b&gt; &amp; &lt;/memory_context&gt;\n</memory_context>"
  );
});

test("each memory block keeps to its character budget and says how many facts it left out", () => {
  const fact = (i: number, size: number) => ({ content: `Fact ${i} ${"x".repeat(size)}`, createdAt: day("2026-10-01"), via: "Bot" });
  const profile = renderMemoryFactSnapshot({ profile: Array.from({ length: 12 }, (_, i) => fact(i, 450)), recent: [] });
  expect(profile.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(8);
  expect(profile).toEndWith("(4 more profile facts not shown. Call RecallMemory to search them.)");
  expect(renderMemoryFactSnapshot({ profile: [], recent: [fact(0, 5000), fact(1, 10)] })).toEndWith("(1 more log facts not shown. Call RecallMemory to search them.)");
  expect(renderUserMemoryFactSnapshot({ profile: [], recent: Array.from({ length: 6 }, (_, i) => fact(i, 450)) }))
    .toEndWith("(2 more shared log facts not shown. Call RecallMemory to search them.)");
});
