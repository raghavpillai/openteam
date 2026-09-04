import { describe, expect, test } from "bun:test";
import {
  formatIdleGapTimestamp,
  shouldShowIdleGapTimestamp,
} from "../../src/renderer/lib/message-timestamps";

describe("message timestamp separators", () => {
  test("starts the transcript and returns after a thirty minute idle gap", () => {
    expect(shouldShowIdleGapTimestamp(undefined, "2026-08-25T20:00:00.000Z")).toBe(true);
    expect(shouldShowIdleGapTimestamp("2026-08-25T20:00:00.000Z", "2026-08-25T20:29:59.999Z")).toBe(
      false
    );
    expect(shouldShowIdleGapTimestamp("2026-08-25T20:00:00.000Z", "2026-08-25T20:30:00.000Z")).toBe(
      true
    );
  });

  test("uses relative calendar labels in the viewer time zone", () => {
    const now = new Date("2026-08-25T22:30:00.000Z");
    expect(formatIdleGapTimestamp("2026-08-25T21:59:00.000Z", now, "America/New_York")).toBe(
      "Today 5:59 PM"
    );
    expect(formatIdleGapTimestamp("2026-08-24T21:36:00.000Z", now, "America/New_York")).toBe(
      "Yesterday 5:36 PM"
    );
    expect(formatIdleGapTimestamp("2026-08-21T13:10:00.000Z", now, "America/New_York")).toBe(
      "Friday 9:10 AM"
    );
    expect(formatIdleGapTimestamp("2026-08-12T13:10:00.000Z", now, "America/New_York")).toBe(
      "Aug 12, 2026, 9:10 AM"
    );
  });
});
