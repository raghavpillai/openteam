import { describe, expect, test } from "bun:test";
import { formatRosterTimestamp } from "../src/timestamps";

describe("roster timestamps", () => {
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
