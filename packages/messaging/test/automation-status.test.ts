import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_STATUS_CLEARED,
  renderAutomationStatusReminder,
  routineDefinitionLine,
} from "../src/automation-status";
import { acknowledgeAutomationStatus, prepareAutomationStatus, preparePromptSections } from "../src/prompt-sections";
import { turnSystemReminder } from "../src/turn-notes";

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

describe("routine definitions and runtime status", () => {
  test("definition lines name the trigger, its schedule and the folder, as the reference does", () => {
    expect(routineDefinitionLine(digest)).toBe("- Morning digest [enabled]: Weekdays at 8:47 AM (47 8 * * 1-5); folder morning-digest");
    expect(routineDefinitionLine({ ...vendor, enabled: false })).toBe(
      "- Vendor replies [paused]: When email arrives at me+vendor@mail.example; folder vendor-replies"
    );
  });

  test("the per-turn reminder has next and last runs in the user's zone", () => {
    expect(renderAutomationStatusReminder([digest, vendor], "America/Los_Angeles")).toBe([
      "<system_reminder>",
      "<automation_status>",
      "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.",
      "- Morning digest (folder morning-digest): next run 10/20/2026, 6:05:37 PM PDT; last run 10/19/2026, 5:05:37 PM PDT (succeeded)",
      "- Vendor replies (folder vendor-replies): never run",
      "</automation_status>",
      "</system_reminder>",
    ].join("\n"));
    const running = { ...vendor, runLedger: [{ status: "running", startedAt: Date.UTC(2026, 9, 20, 1) }, { status: "error", startedAt: Date.UTC(2026, 9, 19, 1) }] };
    expect(renderAutomationStatusReminder([running], "UTC")).toContain("running now (started 10/20/2026, 1:00:00 AM UTC)");
    // The routine that is firing shows its previous outcome, not its own run.
    expect(renderAutomationStatusReminder([running], "UTC", "r2")).toContain("last run 10/19/2026, 1:00:00 AM UTC (failed)");
    expect(renderAutomationStatusReminder([], "UTC")).toBeNull();
  });

  test("the reminder goes out only when it changed or a summary dropped it from context", () => {
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

  test("the reminder joins the turn's single reminder block first, unwrapped", () => {
    const live = renderAutomationStatusReminder([vendor], "UTC")!;
    expect(turnSystemReminder([live, "<instructions_update>\nx\n</instructions_update>"])).toBe([
      "<system_reminder>",
      "<automation_status>",
      "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.",
      "- Vendor replies (folder vendor-replies): never run",
      "</automation_status>",
      "",
      "<instructions_update>\nx\n</instructions_update>",
      "</system_reminder>",
    ].join("\n"));
  });
});
