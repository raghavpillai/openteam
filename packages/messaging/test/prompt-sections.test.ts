import { expect, test } from "bun:test";
import { acknowledgePromptSections, preparePromptSections } from "../src/prompt-sections";

test("change notes survive an undelivered turn, acknowledge once, and fold after summary", () => {
  const initial = preparePromptSections({}, 0, {
    memory: "old",
    automations: "routine one",
    agent_instructions: "old instructions",
  });
  const live = {
    memory: "new",
    automations: "routine two",
    agent_instructions: "new instructions",
  };
  const edited = preparePromptSections(initial.snapshots, 0, live);
  expect(edited.sections.memory).toBe("old");
  expect(edited.sections.agent_instructions).toBe("old instructions");
  expect(edited.update).toContain("new instructions");
  expect(preparePromptSections(edited.snapshots, 0, live).update).toBe(edited.update);
  const acknowledged = acknowledgePromptSections(edited.snapshots, edited.receipts);
  expect(preparePromptSections(acknowledged, 0, live).update).toBeNull();
  const compacted = preparePromptSections(acknowledged, 1, live);
  expect(compacted.sections).toEqual(live);
  expect(compacted.update).toBeNull();
});

test("stale acknowledgements cannot undo newer delivery or a new epoch", () => {
  const initial = preparePromptSections({}, 2, { memory: "A" });
  const b = preparePromptSections(initial.snapshots, 2, { memory: "B" });
  const bAck = acknowledgePromptSections(b.snapshots, b.receipts);
  const c = preparePromptSections(bAck, 2, { memory: "C" });
  const cAck = acknowledgePromptSections(c.snapshots, c.receipts);
  expect(acknowledgePromptSections(cAck, b.receipts)).toEqual(cAck);
  const nextEpoch = preparePromptSections(cAck, 3, { memory: "D" });
  expect(acknowledgePromptSections(nextEpoch.snapshots, c.receipts)).toEqual(nextEpoch.snapshots);
});

test("empty sections freeze and deletions produce replacement notes; connectors wait for summary", () => {
  const initial = preparePromptSections({}, 0, { memory: "", mcp_instructions: "original" });
  const next = preparePromptSections(initial.snapshots, 0, {
    memory: "added",
    mcp_instructions: "edited",
  });
  expect(next.sections.memory).toBe("");
  expect(next.sections.mcp_instructions).toBe("original");
  expect(next.receipts.map((receipt) => receipt.name)).toEqual(["memory"]);
  const deleted = preparePromptSections(
    acknowledgePromptSections(next.snapshots, next.receipts),
    0,
    { memory: "" }
  );
  expect(deleted.update).toContain("This section is now empty.");
});

test("successive sparse updates diff from the last acknowledged version, then fold on compaction", () => {
  const initial = preparePromptSections({}, 4, { memory: "alpha\nbeta\ngamma\ndelta\nepsilon" });
  const edit = preparePromptSections(initial.snapshots, 4, {
    memory: "alpha\nbeta\nGAMMA\ndelta\nepsilon",
  });
  expect(edit.update).toContain("## Memory (changed lines only)\n- gamma\n+ GAMMA");
  expect(edit.update).not.toContain("alpha");
  expect(preparePromptSections(edit.snapshots, 4, { memory: edit.receipts[0]!.next }).update).toBe(
    edit.update
  );
  const acknowledged = acknowledgePromptSections(edit.snapshots, edit.receipts);
  const again = preparePromptSections(acknowledged, 4, {
    memory: "alpha\nbeta\nGAMMA\nDELTA\nepsilon",
  });
  expect(again.update).toContain("- delta\n+ DELTA");
  expect(again.update).not.toContain("gamma");
  expect(again.sections.memory).toBe(initial.sections.memory);
  const compacted = preparePromptSections(
    acknowledgePromptSections(again.snapshots, again.receipts),
    5,
    { memory: again.receipts[0]!.next }
  );
  expect(compacted.update).toBeNull();
  expect(compacted.sections.memory).toContain("GAMMA\nDELTA");
});

test("full replacements win for large diffs, additions and bounded-work fallback", () => {
  for (const [previous, next] of [
    ["A", "B"],
    ["", "new"],
    [
      Array.from({ length: 501 }, (_, i) => `row ${i}`).join("\n"),
      Array.from({ length: 501 }, (_, i) => `row ${i === 0 ? "edited" : i}`).join("\n"),
    ],
  ]) {
    const initial = preparePromptSections({}, 0, { memory: previous! });
    const edited = preparePromptSections(initial.snapshots, 0, { memory: next! });
    expect(edited.update).toContain(`## Memory\n${next}`);
    expect(edited.update).not.toContain("## Memory (changed lines only)");
  }
});
