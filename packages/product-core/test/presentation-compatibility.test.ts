import { describe, expect, test } from "bun:test";
import { BOT_AVATAR_DEALT_COLORS } from "@openteam/contracts/bot-avatar";
import { routineExecutionStatusPresentation } from "../src/routines";
import { formatRosterTimestamp } from "../src/timestamps";

describe("shared helpers preserve the existing desktop and iOS presentation", () => {
  test("routine labels remain identical in all three existing surfaces", () => {
    const labels = [
      ["queued", "Queued", "Running", "queued"],
      ["running", "Running", "Running", "running"],
      ["waiting_approval", "Needs approval", "Running", "waiting approval"],
      ["completed", "Succeeded", "Succeeded", "completed"],
      ["failed", "Failed", "Failed", "failed"],
      ["cancelled", "Cancelled", "Cancelled", "cancelled"],
      ["skipped", "Skipped", "Skipped", "skipped"],
    ] as const;
    for (const [status, detail, activity, raw] of labels) {
      expect(routineExecutionStatusPresentation(status).label).toBe(detail);
      expect(routineExecutionStatusPresentation(status, "activity").label).toBe(activity);
      expect(routineExecutionStatusPresentation(status, "raw").label).toBe(raw);
    }
  });
  test("the native white swatch and remaining palette order are unchanged", () => {
    expect(["#ffffff", ...BOT_AVATAR_DEALT_COLORS]).toEqual([
      "#ffffff",
      "#a47952",
      "#f23d52",
      "#ff7a1a",
      "#ff9e12",
      "#10b972",
      "#27baae",
      "#4b8efb",
      "#925df2",
      "#ef479b",
      "#878787",
    ]);
  });
  test("all roster variants show weekdays for recent conversations", () => {
    const now = new Date(2026, 8, 3, 17);
    const today = new Date(2026, 8, 3, 10, 15);
    const yesterday = new Date(2026, 8, 2, 10, 15);
    const earlier = new Date(2026, 8, 1, 10, 15);
    const old = new Date(2026, 7, 20, 10, 15);
    for (const variant of ["compact", "expanded"] as const) {
      expect(formatRosterTimestamp(today.toISOString(), variant, now)).toBe(
        today.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      );
      expect(formatRosterTimestamp(yesterday.toISOString(), variant, now)).toBe("Yesterday");
      expect(formatRosterTimestamp(old.toISOString(), variant, now)).toBe(
        old.toLocaleDateString([], { month: "numeric", day: "numeric" })
      );
    }
    expect(formatRosterTimestamp(earlier.toISOString(), "compact", now)).toBe(
      earlier.toLocaleDateString([], { weekday: "long" })
    );
    expect(formatRosterTimestamp(earlier.toISOString(), "expanded", now)).toBe(
      earlier.toLocaleDateString([], { weekday: "long" })
    );
    expect(formatRosterTimestamp(undefined)).toBe("");
  });
  test("calendar-day labels survive a daylight-saving transition", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const now = new Date(2026, 2, 9, 12);
      const previous = new Date(2026, 2, 8, 12);
      for (const variant of ["compact", "expanded"] as const) {
        expect(formatRosterTimestamp(previous.toISOString(), variant, now)).toBe("Yesterday");
        const sixDaysAgo = new Date(2026, 2, 3, 12);
        expect(formatRosterTimestamp(sixDaysAgo.toISOString(), variant, now)).toBe("Tuesday");
        const sevenDaysAgo = new Date(2026, 2, 2, 12);
        expect(formatRosterTimestamp(sevenDaysAgo.toISOString(), variant, now)).toBe(
          sevenDaysAgo.toLocaleDateString([], { month: "numeric", day: "numeric" })
        );
      }
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });
});
