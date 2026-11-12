import { describe, expect, test } from "bun:test";
import { AUTOMATION_STATUS_CLEARED, renderAutomationStatusReminder, routineDefinitionLine } from "../src/automation-status";
import {
  acknowledgeAutomationStatus,
  prepareAutomationStatus,
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
  });
  const live = {
    agent_directory: "new",
    automations: "routine two",
  };
  const edited = preparePromptSections(initial.snapshots, 0, live);
  expect(edited.sections.agent_directory).toBe("old");
  expect(edited.update).toContain("new");
  expect(preparePromptSections(edited.snapshots, 0, live).update).toBe(edited.update);
  const acknowledged = acknowledgePromptSections(edited.snapshots, edited.receipts);
  expect(preparePromptSections(acknowledged, 0, live).update).toBeNull();
  const compacted = preparePromptSections(acknowledged, 1, live);
  expect(compacted.sections).toEqual(live);
  expect(compacted.update).toBeNull();
});

test("stale acknowledgements cannot undo newer delivery or a new epoch", () => {
  const initial = preparePromptSections({}, 2, { agent_directory: "A" });
  const b = preparePromptSections(initial.snapshots, 2, { agent_directory: "B" });
  const bAck = acknowledgePromptSections(b.snapshots, b.receipts);
  const c = preparePromptSections(bAck, 2, { agent_directory: "C" });
  const cAck = acknowledgePromptSections(c.snapshots, c.receipts);
  expect(acknowledgePromptSections(cAck, b.receipts)).toEqual(cAck);
  const nextEpoch = preparePromptSections(cAck, 3, { agent_directory: "D" });
  expect(acknowledgePromptSections(nextEpoch.snapshots, c.receipts)).toEqual(nextEpoch.snapshots);
});

test("successive sparse updates diff from the last acknowledged version, then fold on compaction", () => {
  const initial = preparePromptSections({}, 4, { agent_directory: "alpha\nbeta\ngamma\ndelta\nepsilon" });
  const edit = preparePromptSections(initial.snapshots, 4, {
    agent_directory: "alpha\nbeta\nGAMMA\ndelta\nepsilon",
  });
  expect(edit.update).toContain("## Teammates and groups (changed lines only)\n- gamma\n+ GAMMA");
  expect(edit.update).not.toContain("alpha");
  expect(preparePromptSections(edit.snapshots, 4, { agent_directory: edit.receipts[0]!.next }).update).toBe(
    edit.update
  );
  const acknowledged = acknowledgePromptSections(edit.snapshots, edit.receipts);
  const again = preparePromptSections(acknowledged, 4, {
    agent_directory: "alpha\nbeta\nGAMMA\nDELTA\nepsilon",
  });
  expect(again.update).toContain("- delta\n+ DELTA");
  expect(again.update).not.toContain("gamma");
  expect(again.sections.agent_directory).toBe(initial.sections.agent_directory);
  const compacted = preparePromptSections(
    acknowledgePromptSections(again.snapshots, again.receipts),
    5,
    { agent_directory: again.receipts[0]!.next }
  );
  expect(compacted.update).toBeNull();
  expect(compacted.sections.agent_directory).toContain("GAMMA\nDELTA");
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


describe("routine status reminder", () => {
  const digest = {
    id: "r1", name: "Morning digest", slug: "morning-digest", enabled: true,
    trigger: { type: "cron", schedule: "47 8 * * 1-5" }, scheduleText: "47 8 * * 1-5",
    nextRunAt: new Date(Date.UTC(2026, 9, 21, 1, 5, 37)),
    runLedger: [{ id: "a", status: "ok", startedAt: Date.UTC(2026, 9, 20, 0, 5, 37) }],
  };
  const vendor = {
    id: "r2", name: "Vendor replies", slug: "vendor-replies", enabled: true,
    trigger: { type: "email", inbox: "me+vendor@mail.example" }, scheduleText: "Event: email", nextRunAt: null, runLedger: [],
  };

  test("lines name the trigger, folder, and next and last runs in the user's zone", () => {
    expect(routineDefinitionLine({ ...vendor, enabled: false })).toBe("- Vendor replies [paused]: When email arrives at me+vendor@mail.example; folder vendor-replies");
    const reminder = renderAutomationStatusReminder([digest, vendor], "America/Los_Angeles")!;
    expect(reminder).toStartWith("<system_reminder>\n<automation_status>\n");
    expect(reminder).toContain("- Morning digest [enabled]: Weekdays at 8:47 AM (47 8 * * 1-5); folder morning-digest; next run 10/20/2026, 6:05:37 PM PDT; last run 10/19/2026, 5:05:37 PM PDT (succeeded)");
    expect(reminder).toContain("folder vendor-replies; never run");
    const running = { ...vendor, runLedger: [{ status: "running", startedAt: Date.UTC(2026, 9, 20, 1) }, { status: "error", startedAt: Date.UTC(2026, 9, 19, 1) }] };
    expect(renderAutomationStatusReminder([running], "UTC")).toContain("running now (started 10/20/2026, 1:00:00 AM UTC)");
    // The routine that is firing shows its previous outcome, not its own run.
    expect(renderAutomationStatusReminder([running], "UTC", "r2")).toContain("last run 10/19/2026, 1:00:00 AM UTC (failed)");
    expect(renderAutomationStatusReminder([], "UTC")).toBeNull();
  });

  test("goes out only when it changed or a summary dropped it from context", () => {
    const live = renderAutomationStatusReminder([digest], "UTC")!;
    const { snapshots } = preparePromptSections(undefined, 0, { automations: "Scheduled routines:" });
    const first = prepareAutomationStatus(snapshots, 0, live, AUTOMATION_STATUS_CLEARED);
    expect(first.note).toBe(live);
    acknowledgeAutomationStatus(snapshots, first.receipt!);
    expect(prepareAutomationStatus(snapshots, 0, live, AUTOMATION_STATUS_CLEARED).note).toBeNull();
    const later = renderAutomationStatusReminder([{ ...digest, runLedger: [] }], "UTC")!;
    expect(prepareAutomationStatus(snapshots, 0, later, AUTOMATION_STATUS_CLEARED).note).toBe(later);
    // A new epoch keeps the last delivered status but it is no longer in context.
    const next = preparePromptSections(snapshots, 1, { automations: "Scheduled routines:" }).snapshots;
    expect(next.automations?.automationStatus?.render).toBe(live);
    expect(prepareAutomationStatus(next, 1, live, AUTOMATION_STATUS_CLEARED).note).toBe(live);
    // Deleting the last routine tells the bot once; with none ever shown, nothing is sent.
    expect(prepareAutomationStatus(snapshots, 0, null, AUTOMATION_STATUS_CLEARED).note).toBe(AUTOMATION_STATUS_CLEARED);
    expect(prepareAutomationStatus(preparePromptSections(undefined, 0, { automations: "" }).snapshots, 0, null, AUTOMATION_STATUS_CLEARED).note).toBeNull();
  });

});
