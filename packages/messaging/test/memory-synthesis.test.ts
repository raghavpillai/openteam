import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMemoryFact,
  applyMemorySynthesis,
  markMemoryOrigin,
  memoryOrigin,
  prepareMemorySynthesis,
  readMemoryTree,
} from "../src/memory-files";
import { parseMemorySynthesisChanges, synthesizeMemories } from "../src/memory-synthesis";

for (const action of ["remove", "update"] as const) {
  test(`synthesis cannot ${action} a memory explicitly saved during inference`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-origin-race-"));
    try {
      const fact = await appendMemoryFact(root, "Prefers exact totals.", "profile");
      const before = await prepareMemorySynthesis(root);
      expect(before.memories[0]?.origin).toBe("legacy");
      await markMemoryOrigin(root, fact.logicalId, "explicit");
      expect((await prepareMemorySynthesis(root)).fingerprint).toBe(before.fingerprint);
      const change =
        action === "remove"
          ? { action, id: fact.logicalId, sourceEvidenceIds: ["e1"] }
          : {
              action,
              id: fact.logicalId,
              content: "Prefers rounded totals.",
              kind: "profile" as const,
              sourceEvidenceIds: ["e1"],
            };
      expect(await applyMemorySynthesis(root, before, [change])).toBe("invalid");
      expect((await readMemoryTree(root)).map(({ content }) => content)).toEqual([
        "Prefers exact totals.",
      ]);
      expect(await memoryOrigin(root, fact.logicalId)).toBe("explicit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const evidence = [
  {
    id: "123e4567-e89b-12d3-a456-426614174000",
    occurredAt: Date.parse("2026-09-12"),
    user: "Use cobalt.",
    assistant: "Understood.",
  },
];
const validChange = {
  action: "create" as const,
  content: "Prefers cobalt.",
  kind: "profile" as const,
  sourceEvidenceIds: [evidence[0]!.id],
};
const snapshot = { fingerprint: "fixture", memories: [] };

test("no-op synthesis skips verification", async () => {
  const kinds: string[] = [];
  expect(
    await synthesizeMemories({
      snapshot,
      evidence,
      temporal: false,
      infer: async (request) => {
        kinds.push(request.kind);
        return '{"changes":[]}';
      },
    })
  ).toEqual([]);
  expect(kinds).toEqual(["synthesis"]);
});

test("a rejected proposal retries synthesis and verification together", async () => {
  const kinds: string[] = [];
  const delays: number[] = [];
  const budgets: number[] = [];
  let verifications = 0;
  const result = await synthesizeMemories({
    snapshot,
    evidence,
    temporal: false,
    now: Date.parse("2026-09-12T12:00:00Z"),
    sleep: async (ms) => {
      delays.push(ms);
    },
    infer: async (request) => {
      kinds.push(request.kind);
      budgets.push(request.timeoutMs);
      const input = JSON.parse(request.prompt);
      expect(input.today).toBe("2026-09-12");
      if (request.kind === "synthesis") {
        expect(input.newEvidence).toEqual(evidence);
        return JSON.stringify({ changes: [validChange] });
      }
      expect(input.proposedChanges).toEqual([validChange]);
      return JSON.stringify({ approved: ++verifications > 1 });
    },
  });
  expect(result).toEqual([validChange]);
  expect(kinds).toEqual(["synthesis", "verification", "synthesis", "verification"]);
  expect(delays).toEqual([2_000]);
  expect(budgets.every((budget) => budget > 0 && budget <= 90_000)).toBe(true);
});

test("exhausted rejected or malformed proposals cannot produce a commit", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await expect(
    synthesizeMemories({
      snapshot,
      evidence,
      temporal: false,
      sleep: async (ms) => {
        delays.push(ms);
      },
      infer: async () => {
        attempts += 1;
        return JSON.stringify({ changes: [{ ...validChange, sourceEvidenceIds: ["invented"] }] });
      },
    })
  ).rejects.toThrow("unknown evidence");
  expect(attempts).toBe(3);
  expect(delays).toEqual([2_000, 4_000]);
});

test("each attempt has a fresh deadline even when inference ignores its timeout", async () => {
  let attempts = 0;
  await expect(
    synthesizeMemories({
      snapshot,
      evidence,
      temporal: false,
      deadlineMs: 5,
      sleep: async () => {},
      infer: async () => {
        attempts += 1;
        return new Promise<string>(() => {});
      },
    })
  ).rejects.toThrow("deadline exceeded");
  expect(attempts).toBe(3);
});

test("stopping the lifecycle cancels an in-flight proposal without verification or retry", async () => {
  const controller = new AbortController();
  const kinds: string[] = [];
  await expect(
    synthesizeMemories({
      snapshot,
      evidence,
      temporal: false,
      signal: controller.signal,
      sleep: async () => {
        throw new Error("must not retry after stop");
      },
      infer: async (request) => {
        kinds.push(request.kind);
        controller.abort();
        return new Promise<string>(() => {});
      },
    })
  ).rejects.toThrow("stopped");
  expect(kinds).toEqual(["synthesis"]);
});

test("strict synthesis validation rejects unknown fields, unsupported evidence, and empty facts", () => {
  const ids = new Set(evidence.map(({ id }) => id));
  for (const invalid of [
    { ...validChange, extra: "field" },
    { ...validChange, content: "   " },
    { ...validChange, content: "x".repeat(501) },
    { ...validChange, sourceEvidenceIds: [] },
    { ...validChange, sourceEvidenceIds: ["unknown"] },
    { ...validChange, sourceEvidenceIds: ["clock"] },
    { action: "remove", id: "", sourceEvidenceIds: [evidence[0]!.id] },
  ])
    expect(() =>
      parseMemorySynthesisChanges(JSON.stringify({ changes: [invalid] }), ids, true)
    ).toThrow();
  expect(() => parseMemorySynthesisChanges('{"changes":[],"extra":true}', ids, false)).toThrow();
  const removal = { action: "remove" as const, id: "old-id", sourceEvidenceIds: ["clock"] };
  expect(parseMemorySynthesisChanges(JSON.stringify({ changes: [removal] }), ids, true)).toEqual([
    removal,
  ]);
  expect(() =>
    parseMemorySynthesisChanges(JSON.stringify({ changes: [removal] }), ids, false)
  ).toThrow();
});
