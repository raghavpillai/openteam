import { describe, expect, test } from "bun:test";
import { formatTurnTimestamp, resolveTimeZone, timestampUserTurn } from "../src/timestamps";

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
});
