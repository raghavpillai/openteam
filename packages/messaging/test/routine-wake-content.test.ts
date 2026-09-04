import { describe, expect, test } from "bun:test";
import {
  manualRoutineWakeContent,
  scheduledRoutineTriggerContext,
  scheduledRoutineWakeContent,
} from "../src/routines";

describe("scheduled routine wake content", () => {
  test("keeps the durable trigger separate from the ordinary wake text", () => {
    const content = scheduledRoutineWakeContent({
      name: "Daily audit",
      folder: "daily-audit",
      schedule: "0 0 * * *",
      scheduledFor: new Date("2026-08-28T11:00:00.000Z"),
      prompt: "Inspect the queue.",
    });
    expect(content).not.toContain("<automation_trigger_info>");
    expect(content).toBe(
      '[SAND_HIDDEN_PROMPT]\n[routine] "Daily audit" (folder daily-audit) is due — Every day at 12:00 AM (0 0 * * *), fired 2026-08-28T11:00:00.000Z.\nThis is your own routine firing on schedule, not a message the user just typed.\n\nInspect the queue.\n\nUse current sources; report missing or stale inputs instead of inventing data.\nUse SendToUser to deliver a meaningful result or a failure that needs attention. Finishing silently is valid when the saved instruction says there is nothing to report.'
    );
    expect(
      scheduledRoutineTriggerContext({
        name: "Daily audit",
        scheduledFor: new Date("2026-08-28T11:00:00.000Z"),
      })
    ).toBe(
      "<automation_trigger_info>\n[OpenTeam routine: Daily audit]\nScheduled occurrence: 2026-08-28T11:00:00.000Z\n</automation_trigger_info>"
    );
  });

  test("matches Bot's trusted manual-run framing", () => {
    expect(
      manualRoutineWakeContent({
        name: "Daily audit",
        folder: "daily-audit",
        schedule: "0 0 * * *",
        firedAt: new Date("2026-08-28T11:00:00.000Z"),
        prompt: "Inspect the queue.",
        provenance: "user",
      })
    ).toStartWith(
      '[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]\n[routine] "Daily audit" (folder daily-audit) was run on demand — Every day at 12:00 AM (0 0 * * *), fired 2026-08-28T11:00:00.000Z.\nThe user pressed Run now on this routine in the app.'
    );
  });

  test("places the authoritative routine status reminder above the firing body", () => {
    const content = manualRoutineWakeContent({
      name: "Daily audit",
      folder: "daily-audit",
      schedule: "0 0 * * *",
      firedAt: new Date("2026-08-28T11:00:00.000Z"),
      prompt: "Inspect the queue.",
      provenance: "user",
      routineStatuses: [
        { name: "Daily audit", folder: "daily-audit", status: "never run" },
        { name: "Weekly recap", folder: "weekly-recap", status: "last run status unknown" },
      ],
    });
    expect(content).toStartWith(
      "[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]\n<system_reminder>\n<automation_status>\nCurrent routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.\n- Daily audit (folder daily-audit): never run\n- Weekly recap (folder weekly-recap): last run status unknown\n</automation_status>\n</system_reminder>\n\n[routine]"
    );
  });
});
