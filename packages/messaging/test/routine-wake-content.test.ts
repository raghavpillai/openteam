import { describe, expect, test } from "bun:test";
import {
  manualRoutineWakeContent,
  scheduledRoutineWakeContent,
} from "../src/routines";

describe("scheduled routine wake content", () => {
  test("carries no trigger block, only the ordinary wake text", () => {
    const content = scheduledRoutineWakeContent({
      name: "Daily audit",
      folder: "daily-audit",
      schedule: "0 0 * * *",
      scheduledFor: new Date("2026-08-28T11:00:00.000Z"),
      prompt: "Inspect the queue.",
    });
    expect(content).not.toContain("<automation_trigger_info>");
    expect(content).toStartWith('[SAND_HIDDEN_PROMPT]\n[routine] "Daily audit" (folder daily-audit) is due');
    expect(content).toContain("What you saved to do each time:\nInspect the queue.");
    expect(content).toContain("use WakeParent for requested user-visible results or blockers");
    expect(content).toContain("read its current workflow file");
    expect(content).toContain("discover the current tool schema");
    expect(content).toContain("do not send filler or progress acknowledgements");
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
      '[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]\n[routine] "Daily audit" (folder daily-audit) was run on demand — Every day at 12:00 AM (0 0 * * *), fired 2026-08-28T11:00:00.000Z.\nThe user pressed Run now on this routine in the app; this is that run, not a message they typed.'
    );
  });
});
