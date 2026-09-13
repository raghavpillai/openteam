import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import reference from "./fixtures/memory-state-reference.json";
import {
  applyMemorySynthesis,
  markMemoryOrigin,
  memoryLogicalId,
  memoryOrigin,
  prepareMemorySynthesis,
  readMemoryTree,
  tombstoneMemory,
  consumeEvidence,
  boundMemoryEvidenceText,
} from "../src/memory-files";
import { parseMemorySynthesisChanges } from "../src/memory-synthesis";

// Expected state is produced by the captured Grok Bot FileMemoryStore, including
// the order and chosen occurrence of manually duplicated facts.
for (const fixture of reference.cases) {
  test(`reference memory state: ${fixture.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-state-parity-"));
    try {
      for (const [name, raw] of Object.entries(fixture.files)) {
        if (typeof raw !== "string") continue;
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), raw);
      }
      for (const content of fixture.explicit ?? []) {
        await markMemoryOrigin(root, memoryLogicalId(content), "explicit");
      }
      for (const content of fixture.tombstones ?? []) {
        await tombstoneMemory(root, memoryLogicalId(content));
      }
      const snapshot = await prepareMemorySynthesis(root);
      if (fixture.concurrent) await appendFile(join(root, "profile.md"), fixture.concurrent);
      const changes = parseMemorySynthesisChanges(
        JSON.stringify({ changes: fixture.changes }),
        new Set(["e1"]),
        false
      );
      const outcome = await applyMemorySynthesis(root, snapshot, changes, new Date(fixture.now));
      const facts = await Promise.all(
        (await readMemoryTree(root)).map(async (fact) => ({
          id: fact.logicalId,
          content: fact.content,
          createdAt: fact.createdAt.getTime(),
          kind: fact.sourcePath === "profile.md" ? "profile" : "log",
          origin: await memoryOrigin(root, fact.logicalId),
        }))
      );
      expect(fixture.expected).toEqual({ snapshot: snapshot.memories, outcome, facts });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("spool scanning retains the full set for batch cleanup and bounds decoded Unicode and escaped text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-spool-parity-"));
  try {
    const spool = join(root, ".dreaming", "evidence");
    await mkdir(spool, { recursive: true });
    const user = '"'.repeat(9_000);
    const assistant = "東京".repeat(4_500);
    for (let index = 0; index < 20; index++) {
      const id = `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`;
      await writeFile(
        join(spool, `${id}.json`),
        JSON.stringify({ id, occurredAt: index, user, assistant })
      );
    }
    const evidence = await consumeEvidence(root);
    expect(evidence).toHaveLength(20);
    expect(evidence.map(({ occurredAt }) => occurredAt)).toEqual(
      Array.from({ length: 20 }, (_, i) => i)
    );
    expect(evidence[0]?.user).toBe(boundMemoryEvidenceText(user));
    expect(evidence[0]?.assistant).toBe(boundMemoryEvidenceText(assistant));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
