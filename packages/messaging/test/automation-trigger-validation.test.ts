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

test("schedule and trigger together are refused", () => {
  expect(() => normalizeRoutineMutationTrigger({ schedule: "0 9 * * *", trigger: { type: "webhook" } }, "UTC")).toThrow(
    "pass either 'schedule' (a cron routine) or 'trigger' (an event-driven one), never both."
  );
});

test("repo-wide listeners may not carry the high-volume event kinds", () => {
  const refusal = (trigger: unknown) => {
    try {
      normalizeRoutineMutationTrigger({ trigger }, "UTC");
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect(refusal({ type: "github", repo: "org/app", events: ["pr-opened", "pr-pushed", "review-commented"] })).toBe(
    `the github listener on "org/app" was not saved: pr-pushed, review-commented are not scoped on the repo. Narrow it with a 'pr' or 'userAllowlist' filter and try again.`
  );
  expect(refusal([{ type: "cron", schedule: "0 9 * * 1-5" }, { type: "origin", repo: "org/app", events: ["pr-comment"] }])).toBe(
    `the origin listener on "org/app" was not saved: pr-comment are not scoped on the repo. Narrow it with a 'pr' or 'userAllowlist' filter and try again.`
  );
  expect(refusal({ type: "github", repo: "org/app", events: ["pr-pushed", "pr-comment"], pr: 7 })).toBeNull();
  expect(refusal({ type: "github", repo: "org/app", events: ["inline-review-comment"], userAllowlist: ["@octocat"] })).toBeNull();
  expect(refusal({ type: "github", repo: "org/app", events: ["pr-opened", "pr-merged"] })).toBeNull();
});

test("a repo listener left with no CI scope says what it needs", () => {
  expect(() => parseStoredTrigger({ type: "github", repo: "org/app", events: ["ci-failed"] })).toThrow(
    "the github trigger needs 'ciBranch' (ci-passed and ci-failed fire on one branch's settled checks)."
  );
  expect(() => parseStoredTrigger({ type: "origin", repo: "org/app", events: ["ci-passed"] })).toThrow(
    "the origin trigger needs 'pr' (Origin CI events are delivered only for one explicitly scoped PR)."
  );
  expect(() => parseStoredTrigger({ type: "github", repo: "org/app", events: ["deploy"] })).toThrow(
    "the github trigger needs 'events' (at least one GitHub event kind)."
  );
  // As in the reference, unscoped CI kinds beside other kinds are dropped.
  expect(parseStoredTrigger({ type: "github", repo: "org/app", events: ["pr-opened", "ci-failed"] })).toMatchObject({ events: ["pr-opened"] });
});
