import { describe, expect, test } from "bun:test";
import { formatFriendlyDate, formatTimeZoneWithOffset, formatTurnTimestamp, resolveTimeZone, timestampUserTurn } from "../src/timestamps";

describe("model turn timestamps", () => {
  test("formats the user's local wall clock and UTC offset", () => {
    expect(formatTurnTimestamp("2026-08-25T15:00:00.000Z", "Asia/Jerusalem")).toBe(
      "Tuesday, Aug 25, 2026, 6:00 PM (UTC+3)"
    );
    expect(formatTurnTimestamp("2026-01-15T17:30:00.000Z", "America/St_Johns")).toBe(
      "Thursday, Jan 15, 2026, 2:00 PM (UTC-3:30)"
    );
  });

  test("wraps one timestamp around the complete delivered turn", () => {
    expect(
      timestampUserTurn('[Group chat: "Testing"]\nUser: Hello', {
        occurredAt: "2026-08-25T15:00:00.000Z",
        timeZone: "Asia/Jerusalem",
      })
    ).toBe(
      '<timestamp>Tuesday, Aug 25, 2026, 6:00 PM (UTC+3)</timestamp>\n<user_query>\n[Group chat: "Testing"]\nUser: Hello\n</user_query>'
    );
  });

  test("falls back safely when a client sends an invalid zone", () => {
    expect(resolveTimeZone("not/a-zone")).toBe("UTC");
  });

  test("labels the zone with its current offset and the date as the reference does", () => {
    const summer = new Date("2026-07-01T12:00:00Z");
    expect(formatTimeZoneWithOffset("Europe/Paris", summer)).toBe("Europe/Paris (currently UTC+2)");
    expect(formatTimeZoneWithOffset("Europe/Paris", new Date("2026-12-01T12:00:00Z"))).toBe("Europe/Paris (currently UTC+1)");
    expect(formatTimeZoneWithOffset("America/Los_Angeles", summer)).toBe("America/Los_Angeles (currently UTC-7)");
    expect(formatTimeZoneWithOffset("Asia/Kolkata", summer)).toBe("Asia/Kolkata (currently UTC+5:30)");
    expect(formatTimeZoneWithOffset("UTC", summer)).toBe("UTC (currently UTC+0)");
    expect(formatFriendlyDate(new Date("2026-10-21T22:30:00Z"), "Asia/Tokyo")).toBe("Thursday Oct 22, 2026");
    expect(formatFriendlyDate(new Date("2026-10-01T12:00:00Z"), "UTC")).toBe("Thursday Oct 1, 2026");
  });
});
