import { expect, test } from "bun:test";
import { normalizeRoutineMutationTrigger } from "../src/routines";
import { parseStoredTrigger } from "../src/automation-trigger";

test.each([
  {},
  { type: "unknown" },
  { type: "cron" },
  { type: "group", listeners: [] },
  { type: "slack", channel: "#eng", match: { kind: "unknown" } },
])("invalid automation trigger %j is a client error", (trigger) => {
  expect(() => normalizeRoutineMutationTrigger({ trigger }, "UTC")).toThrow(
    expect.objectContaining({ status: 400, code: "invalid_routine_trigger" })
  );
});

test("oversized trigger groups are rejected instead of silently dropping listeners", () => {
  const listeners = Array.from({ length: 9 }, (_, index) => ({
    type: "cron",
    schedule: `0 ${index} * * *`,
  }));
  for (const trigger of [
    listeners,
    { type: "group", listeners },
    { type: "group", triggers: listeners },
  ]) {
    expect(() => parseStoredTrigger(trigger)).toThrow("at most 8");
  }
  expect(parseStoredTrigger({ type: "group", listeners: listeners.slice(0, 8) })).toMatchObject({
    listeners: listeners.slice(0, 8),
  });
});
