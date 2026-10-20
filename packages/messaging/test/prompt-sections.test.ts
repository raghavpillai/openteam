import { expect, test } from "bun:test";
import {
  acknowledgeMemoryContext,
  acknowledgePromptSections,
  parsePromptSections,
  prepareMemoryContext,
  preparePromptSections,
  type PromptSectionSnapshot,
} from "../src/prompt-sections";

test("change notes survive an undelivered turn, acknowledge once, and fold after summary", () => {
  const initial = preparePromptSections({}, 0, {
    agent_directory: "old",
    automations: "routine one",
    agent_instructions: "old instructions",
  });
  const live = {
    agent_directory: "new",
    automations: "routine two",
    agent_instructions: "new instructions",
  };
  const edited = preparePromptSections(initial.snapshots, 0, live);
  expect(edited.sections.agent_directory).toBe("old");
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
  const initial = preparePromptSections({}, 2, { agent_instructions: "A" });
  const b = preparePromptSections(initial.snapshots, 2, { agent_instructions: "B" });
  const bAck = acknowledgePromptSections(b.snapshots, b.receipts);
  const c = preparePromptSections(bAck, 2, { agent_instructions: "C" });
  const cAck = acknowledgePromptSections(c.snapshots, c.receipts);
  expect(acknowledgePromptSections(cAck, b.receipts)).toEqual(cAck);
  const nextEpoch = preparePromptSections(cAck, 3, { agent_instructions: "D" });
  expect(acknowledgePromptSections(nextEpoch.snapshots, c.receipts)).toEqual(nextEpoch.snapshots);
});

test("empty sections freeze and deletions produce replacement notes; connectors wait for summary", () => {
  const initial = preparePromptSections({}, 0, { agent_instructions: "", mcp_instructions: "original" });
  const next = preparePromptSections(initial.snapshots, 0, {
    agent_instructions: "added",
    mcp_instructions: "edited",
  });
  expect(next.sections.agent_instructions).toBe("");
  expect(next.sections.mcp_instructions).toBe("original");
  expect(next.receipts.map((receipt) => receipt.name)).toEqual(["agent_instructions"]);
  const deleted = preparePromptSections(
    acknowledgePromptSections(next.snapshots, next.receipts),
    0,
    { agent_instructions: "" }
  );
  expect(deleted.update).toContain("This section is now empty.");
});

test("successive sparse updates diff from the last acknowledged version, then fold on compaction", () => {
  const initial = preparePromptSections({}, 4, { agent_instructions: "alpha\nbeta\ngamma\ndelta\nepsilon" });
  const edit = preparePromptSections(initial.snapshots, 4, {
    agent_instructions: "alpha\nbeta\nGAMMA\ndelta\nepsilon",
  });
  expect(edit.update).toContain("## Bot-specific instructions (changed lines only)\n- gamma\n+ GAMMA");
  expect(edit.update).not.toContain("alpha");
  expect(preparePromptSections(edit.snapshots, 4, { agent_instructions: edit.receipts[0]!.next }).update).toBe(
    edit.update
  );
  const acknowledged = acknowledgePromptSections(edit.snapshots, edit.receipts);
  const again = preparePromptSections(acknowledged, 4, {
    agent_instructions: "alpha\nbeta\nGAMMA\nDELTA\nepsilon",
  });
  expect(again.update).toContain("- delta\n+ DELTA");
  expect(again.update).not.toContain("gamma");
  expect(again.sections.agent_instructions).toBe(initial.sections.agent_instructions);
  const compacted = preparePromptSections(
    acknowledgePromptSections(again.snapshots, again.receipts),
    5,
    { agent_instructions: again.receipts[0]!.next }
  );
  expect(compacted.update).toBeNull();
  expect(compacted.sections.agent_instructions).toContain("GAMMA\nDELTA");
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
    const initial = preparePromptSections({}, 0, { agent_instructions: previous! });
    const edited = preparePromptSections(initial.snapshots, 0, { agent_instructions: next! });
    expect(edited.update).toContain(`## Bot-specific instructions\n${next}`);
    expect(edited.update).not.toContain("## Bot-specific instructions (changed lines only)");
  }
});

test("memory facts pin per epoch, never as change notes; only other assistants' shared changes are announced", () => {
  const snapshots: Record<string, PromptSectionSnapshot> = {};
  const live = (facts: string, render: string, fingerprint: string) => ({ facts, otherAgents: { render, fingerprint } });
  expect(prepareMemoryContext(snapshots, 0, live("facts A", "peer A", "fa"))).toEqual({ facts: "facts A", changed: false });
  // Own changes alter the facts but not the other assistants' fingerprint: nothing to announce.
  expect(prepareMemoryContext(snapshots, 0, live("facts B", "peer A", "fa"))).toEqual({ facts: "facts A", changed: false });
  const peer = prepareMemoryContext(snapshots, 0, live("facts C", "peer B", "fb"));
  expect(peer).toMatchObject({ facts: "facts A", changed: true, receipt: { previousFingerprint: "fa", otherAgentFingerprint: "fb" } });
  // Undelivered, the same change is announced again; acknowledged, it is not.
  expect(prepareMemoryContext(parsePromptSections(snapshots), 0, live("facts C", "peer B", "fb")).changed).toBe(true);
  const acknowledged = acknowledgeMemoryContext(snapshots, peer.receipt!);
  expect(prepareMemoryContext(acknowledged, 0, live("facts C", "peer B", "fb"))).toEqual({ facts: "facts A", changed: false });
  // A stale receipt cannot overwrite a newer one.
  expect(acknowledgeMemoryContext(acknowledged, { ...peer.receipt!, previousFingerprint: "old", otherAgentFingerprint: "zz" }).memory)
    .toMatchObject({ otherAgentFingerprint: "fb" });
  // A changed fingerprint with the same render is recorded without a note.
  const quiet = prepareMemoryContext(acknowledged, 0, live("facts C", "peer B", "fc"));
  expect(quiet.changed).toBe(false);
  expect(quiet.receipt?.otherAgentFingerprint).toBe("fc");
  // A summary re-pins.
  expect(prepareMemoryContext(acknowledged, 1, live("facts D", "peer B", "fb"))).toEqual({ facts: "facts D", changed: false });
  expect(() => preparePromptSections({}, 0, { memory: "x" })).toThrow("Unknown prompt section memory");
});
