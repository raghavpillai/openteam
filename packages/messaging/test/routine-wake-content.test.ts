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
    expect(content).toBe([
      "[SAND_HIDDEN_PROMPT]",
      '[routine] "Daily audit" (folder daily-audit) is due. Trigger: Every day at 12:00 AM (0 0 * * *), fired 8/28/2026, 11:00:00 AM UTC.',
      "This is your own routine firing on schedule, not a message the user just typed.",
      "What you saved to do each time:",
      "Inspect the queue.",
      "Carry it out now. Keep it self-contained, since the schedule asked for this, not the user just now.",
      "If the instruction mentions a skill (e.g. @Some skill), read that skill file from your workflows folder with Read and run it as part of this. The mention is a pointer, not a copy.",
      "If the saved instruction spells out a specific MCP tool call, treat its arguments as possibly stale, since this routine may have been written long ago, and confirm the current schema with your MCP tool-discovery tool before relying on them.",
    ].join("\n"));

  });

  test("names a dated cron as the one-off it is, and gives the fire time in the routine's zone", () => {
    const content = scheduledRoutineWakeContent({
      name: "Support check",
      folder: "support-check",
      schedule: "10 13 18 10 *",
      scheduledFor: new Date("2026-10-18T20:10:00.000Z"),
      timeZone: "America/Los_Angeles",
      prompt: "Check the support case, then delete this routine.",
    });
    expect(content).toMatch(/is due\. Trigger: Once October 18 at 1:10 PM \(10 13 18 10 \*\), fired 10\/18\/2026, 1:10:00\sPM PDT\./);
    expect(scheduledRoutineWakeContent({
      name: "Weekly", folder: "weekly", schedule: "10 13 * * 0",
      scheduledFor: new Date("2026-10-18T13:10:00.000Z"), prompt: "Check.",
    })).toContain("Trigger: Every Sunday at 1:10 PM (10 13 * * 0)");
    expect(scheduledRoutineWakeContent({
      name: "Odd", folder: "odd", schedule: "10 13 31 2 *",
      scheduledFor: new Date("2026-10-18T13:10:00.000Z"), prompt: "Check.",
    })).not.toContain("Once February 31");
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
      '[SAND_HIDDEN_PROMPT][SAND_TRUSTED_AUTOMATION_PROMPT]\n[routine] "Daily audit" (folder daily-audit) was run on demand. Trigger: Every day at 12:00 AM (0 0 * * *), started 8/28/2026, 11:00:00 AM UTC.\nThe user pressed Run now on this routine in the app; this is that run, not a message they typed.'
    );
  });
});
