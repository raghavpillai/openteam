import { expect, test } from "bun:test";
import { acknowledgePromptSections, preparePromptSections } from "../src/prompt-sections";

test("change notes survive an undelivered turn, acknowledge once, and fold after summary", () => {
  const initial = preparePromptSections({}, 0, { memory: "old", automations: "routine one", agent_instructions: "old instructions" });
  const live = { memory: "new", automations: "routine two", agent_instructions: "new instructions" };
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
  const next = preparePromptSections(initial.snapshots, 0, { memory: "added", mcp_instructions: "edited" });
  expect(next.sections.memory).toBe("");
  expect(next.sections.mcp_instructions).toBe("original");
  expect(next.receipts.map((receipt) => receipt.name)).toEqual(["memory"]);
  const deleted = preparePromptSections(acknowledgePromptSections(next.snapshots, next.receipts), 0, { memory: "" });
  expect(deleted.update).toContain("This section is now empty.");
});
