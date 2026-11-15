import { expect, test } from "bun:test";
import {
  buildExtractionUserPrompt,
  isMemorableExchange,
  parseExtractedMemories,
  renderTurnMemoryDate,
} from "../src/memory-learning";
import { memoryLogicalId, normalizeMemoryContent } from "../src/memory-facts";
import { renderMemoryContextBlock, renderMemoryFactSnapshot, renderUserMemoryFactSnapshot } from "../src/memory-rendering";
import { parseRecallInput, recallMemoryResult } from "../src/recall-memory";

test("extraction lines add, retire and prefix facts, skipping ones already known", () => {
  const lines = ["remove: Lives in Boston.", "profile: Lives in NYC.", "- note: Likes cobalt for the demo.", "log: Lives in Boston.", "An untagged line is history.", "NONE"];
  expect(parseExtractedMemories(lines.join("\n"), ["Lives in Boston."])).toEqual({
    additions: [
      { content: "Lives in NYC.", kind: "profile" },
      { content: "[note] Likes cobalt for the demo.", kind: "log" },
      { content: "An untagged line is history.", kind: "log" },
    ],
    removals: ["Lives in Boston."],
  });
  expect(parseExtractedMemories("  NONE \n", [])).toEqual({ additions: [], removals: [] });
});

test("a correction must name a shown fact; malformed or unknown correction lines reject the whole batch", () => {
  const shown = ["Lives in Boston."];
  // Indentation and a wrapping Markdown fence are formatting, not facts.
  expect(parseExtractedMemories('```json\n  replace: {"old":"Lives in Boston.","fact":"Lives in NYC."}  \n  profile: Prefers tea.\n```', shown)).toEqual({
    additions: [{ content: "Prefers tea.", kind: "profile" }],
    removals: [], replacements: [{ old: "Lives in Boston.", fact: "Lives in NYC." }],
  });
  expect(parseExtractedMemories("```text\nprofile: Likes tea.", [])).toEqual({ additions: [], removals: [] });
  const rejected = [
    'replace: {"old":"Invented existing fact.","fact":"Unfounded correction."}',
    'replace: {"old":"Lives in Boston.","fact":"  "}',
    "replace: null",
    "replace: not-json",
    'replace: {\n  "old": "Lives in Boston.",\n  "fact": "Lives in NYC."\n}',
    'replace: {"old":"Lives in Boston","fact":"Lives in NYC."}\nprofile: Lives in NYC.',
    "remove:\nprofile: Lives in NYC.",
    "remove: Lives in Boston\nprofile: Lives in NYC.",
    'replace: {"old":"Lives in Boston.","fact":"Lives in NYC."}\nreplace: null',
  ];
  for (const raw of rejected) expect(parseExtractedMemories(raw, shown)).toEqual({ additions: [], removals: [] });
});

test("small talk is skipped, anything substantive is reviewed", () => {
  expect(["thanks!", "ok", "ok?", "I moved to Lyon"].map(isMemorableExchange)).toEqual([false, false, true, true]);
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
  expect(renderTurnMemoryDate(new Date("2026-10-05T23:30:00Z"), "Asia/Tokyo")).toBe("Tuesday Oct 6, 2026 (Asia/Tokyo)");
  expect(renderTurnMemoryDate(new Date("2026-10-05T10:00:00Z"), "Not/AZone")).toBe("Monday Oct 5, 2026 (UTC)");
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

test("superseded facts are dropped before scoring and limiting, and labeled in history", () => {
  const candidates = [
    { ...fact("Favourite football player is Ronaldo.", 1), id: "old", supersededAt: new Date("2026-09-02"), supersededById: "new" },
    { ...fact("Favourite player is Messi.", 2), id: "new" },
  ];
  const current = recallMemoryResult({ query: "favourite football player", limit: 1 }, candidates);
  expect(current).toContain("Messi");
  expect(current).not.toContain("Ronaldo");
  expect(current).toContain("id: new; active");
  const history = recallMemoryResult({ query: "favourite football player", includeHistory: true }, candidates);
  expect(history).toContain("Ronaldo");
  expect(history).toContain("superseded 2026-09-02 by new");
  expect(recallMemoryResult({ query: "Ronaldo" }, candidates)).toContain("No facts");
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

test("memory text is cut at 500 whole characters, survives UTF-8 transport, and normalizes idempotently", () => {
  expect(normalizeMemoryContent("x".repeat(499) + "😀")).toBe("x".repeat(499));
  expect(normalizeMemoryContent("x".repeat(498) + "😀" + "tail")).toBe("x".repeat(498) + "😀");
  for (const input of ["name " + String.fromCharCode(0xd83d) + " here", String.fromCharCode(0xde00) + " value", " Spaced\t\nout  é ß "]) {
    const normalized = normalizeMemoryContent(input);
    expect(Buffer.from(normalized).toString("utf8")).toBe(normalized);
    expect(normalizeMemoryContent(normalized)).toBe(normalized);
    expect(memoryLogicalId(normalized)).toBe(memoryLogicalId(input));
  }
});
