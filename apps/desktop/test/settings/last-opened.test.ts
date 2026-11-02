import { expect, test } from "bun:test";
import { lastOpened } from "../../src/renderer/components/openteam/settings/last-opened";

test("offline computers say when they were last opened, in words", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  expect(lastOpened(null, now)).toBe("Not opened yet");
  expect(lastOpened("2026-10-28T11:59:40Z", now)).toMatch(/^Last opened (now|0 minutes ago|this minute)$/);
  expect(lastOpened("2026-10-28T11:55:00Z", now)).toBe("Last opened 5 minutes ago");
  expect(lastOpened("2026-10-27T12:00:00Z", now)).toBe("Last opened yesterday");
  expect(lastOpened("2026-10-21T12:00:00Z", now)).toBe("Last opened last week");
});
