import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExtractedMemories,
  buildEpisodeUserPrompt,
  buildExtractionUserPrompt,
  getMemoryEpisodeInterval,
  parseEpisodeNarrative,
  parseExtractedMemories,
} from "../src/memory-learning";
import { appendMemoryFact, readMemoryTree } from "../src/memory-files";

test("corrections remove only supplied facts, preserve unrelated Markdown, and persist notes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-correction-"));
  const now = new Date("2026-09-12T12:00:00Z");
  try {
    await writeFile(
      join(root, "profile.md"),
      "# Keep this heading\nManual prose.\n- (2020-01-01) Lives in Boston.\n"
    );
    await appendMemoryFact(root, "Unrelated protected preference.", "profile", now);
    const existing = ["Lives in Boston."];
    const parsed = parseExtractedMemories(
      "remove: Lives in Boston.\nremove: Unrelated protected preference.\nprofile: Lives in NYC.\nnote: Likes cobalt for the demo.",
      existing
    );
    expect(await applyExtractedMemories(root, parsed, existing, now)).toEqual({
      added: ["Lives in NYC.", "[note] Likes cobalt for the demo."],
      removed: ["Lives in Boston."],
    });
    expect(await applyExtractedMemories(root, parsed, existing, now)).toEqual({
      added: [],
      removed: [],
    });
    const facts = await readMemoryTree(root);
    expect(facts.map(({ content }) => content)).toEqual([
      "Unrelated protected preference.",
      "Lives in NYC.",
      "[note] Likes cobalt for the demo.",
    ]);
    expect(facts.at(-1)).toMatchObject({
      tier: "note",
      importance: 0.5,
      sourcePath: "log/2026-09.md",
    });
    expect(await readFile(join(root, "profile.md"), "utf8")).toStartWith(
      "# Keep this heading\nManual prose."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("episode input uses absolute dates and retains important details after character 2000", () => {
  const user = `${"x".repeat(2100)} The final decision is cobalt.`;
  const prompt = buildEpisodeUserPrompt([
    { ts: Date.parse("2026-09-12T12:00:00Z"), user, agent: " Done. " },
  ]);
  expect(prompt).toContain("(2026-09-12)");
  expect(prompt).toContain(user);
  expect(prompt).toEndWith("OpenTeam: Done.");
  expect(parseEpisodeNarrative("  NONE \n")).toBeNull();
  expect(
    parseEpisodeNarrative(" Chose   cobalt.\nScheduled the review for September 20, 2026. ")
  ).toBe("Chose cobalt. Scheduled the review for September 20, 2026.");
  expect(buildExtractionUserPrompt("", "", [])).toBe(
    "Existing memory:\n(empty)\n\nLatest exchange:\nUser: (no message)\nAssistant: (no message)"
  );
  expect(
    getMemoryEpisodeInterval({
      OPENTEAM_MEMORY_EPISODE_INTERVAL: "3",
      SAND_MEMORY_EPISODE_INTERVAL: "9",
    })
  ).toBe(3);
});
