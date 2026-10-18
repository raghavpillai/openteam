import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeEvidence, boundMemoryEvidenceText } from "../src/memory-files";

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
