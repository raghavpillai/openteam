import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExtractedMemories,
  buildExtractionUserPrompt,
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

test("an empty exchange still renders the extraction prompt shape", () => {
  expect(buildExtractionUserPrompt("", "", [])).toBe(
    "Existing memory:\n(empty)\n\nLatest exchange:\nUser: (no message)\nAssistant: (no message)"
  );
});
