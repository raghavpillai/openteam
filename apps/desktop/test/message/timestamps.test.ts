import { describe, expect, test } from "bun:test";
import {
  formatIdleGapTimestamp,
  shouldShowIdleGapTimestamp,
} from "../../src/renderer/lib/message-timestamps";

describe("message timestamp separators", () => {
  test("matches the reference labels for today, yesterday, and older dates", () => {
    const now = new Date("2026-10-04T18:00:00Z");
    const zone = "Asia/Jerusalem";
    expect(formatIdleGapTimestamp("2026-10-04T17:27:00Z", now, zone)).toBe("Today 8:27 PM");
    expect(formatIdleGapTimestamp("2026-10-03T17:31:00Z", now, zone)).toBe("Yesterday 8:31 PM");
    expect(formatIdleGapTimestamp("2026-09-30T13:52:00Z", now, zone)).toBe("Wed, Sep 30 4:52 PM");
  });

  test("starts the transcript and returns after a fifteen minute idle gap", () => {
    expect(shouldShowIdleGapTimestamp(undefined, "2026-08-25T20:00:00.000Z")).toBe(true);
    expect(shouldShowIdleGapTimestamp("2026-08-25T20:00:00.000Z", "2026-08-25T20:14:59.999Z")).toBe(
      false
    );
    expect(shouldShowIdleGapTimestamp("2026-08-25T20:00:00.000Z", "2026-08-25T20:15:00.000Z")).toBe(
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
      "Fri, Aug 21 9:10 AM"
    );
    expect(formatIdleGapTimestamp("2026-08-12T13:10:00.000Z", now, "America/New_York")).toBe(
      "Wed, Aug 12 9:10 AM"
    );
    expect(formatIdleGapTimestamp("2025-08-12T13:10:00.000Z", now, "America/New_York")).toBe(
      "Aug 12, 2025 9:10 AM"
    );
  });

  test("updates both sides of midnight using the viewer's calendar day", () => {
    const zone = "America/New_York";
    const before = new Date("2026-10-04T03:59:59Z");
    const after = new Date("2026-10-04T04:23:00Z");
    const evening = "2026-10-04T00:23:00Z";
    const morning = "2026-10-04T04:23:00Z";
    expect(formatIdleGapTimestamp(evening, before, zone)).toBe("Today 8:23 PM");
    expect(formatIdleGapTimestamp(evening, after, zone)).toBe("Yesterday 8:23 PM");
    expect(formatIdleGapTimestamp(morning, after, zone)).toBe("Today 12:23 AM");
  });

  test("separates midnight even when messages are only two minutes apart", () => {
    expect(shouldShowIdleGapTimestamp("2026-09-15T03:59:00Z", "2026-09-15T04:01:00Z", undefined, "America/New_York")).toBe(true);
    expect(shouldShowIdleGapTimestamp("2026-09-15T03:59:00Z", "2026-09-15T04:01:00Z", undefined, "UTC")).toBe(false);
  });

  test("uses calendar yesterday across daylight saving and year boundaries", () => {
    expect(formatIdleGapTimestamp("2026-03-08T05:30:00Z", new Date("2026-03-09T04:15:00Z"), "America/New_York")).toBe("Yesterday 12:30 AM");
    expect(formatIdleGapTimestamp("2025-12-31T17:00:00Z", new Date("2026-01-01T17:00:00Z"), "America/New_York")).toBe("Yesterday 12:00 PM");
    expect(formatIdleGapTimestamp("invalid")).toBe("");
    expect(shouldShowIdleGapTimestamp(undefined, "invalid")).toBe(false);
  });
});
