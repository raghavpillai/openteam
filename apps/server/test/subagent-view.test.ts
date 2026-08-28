import { describe, expect, test } from "bun:test";
import { subagentActivityView } from "../src/services/subagent-view";

const storedSubagent = (result: string | null, error: unknown = null) => ({
  id: "attempt-1",
  parentRunId: "parent-run-1",
  parentChannelId: "channel-1",
  parentToolCallId: "call-1",
  childRunId: "child-run-1",
  description: "Check the release",
  runInBackground: true,
  status: "completed",
  result,
  error,
  startedAt: new Date("2026-08-27T10:00:00.000Z"),
  completedAt: new Date("2026-08-27T10:01:00.000Z"),
  stoppedAt: null,
  createdAt: new Date("2026-08-27T10:00:00.000Z"),
  updatedAt: new Date("2026-08-27T10:01:00.000Z"),
  subagent: {
    id: "subagent-1",
    parentBotId: "parent-1",
    subagentType: "executor",
  },
});

describe("subagent activity view", () => {
  test("projects the tagged summary without exposing the private response", () => {
    const view = subagentActivityView(
      storedSubagent(
        "<user_visible_high_level_summary>Release is ready.</user_visible_high_level_summary>\n<response>Private verification details.</response>"
      )
    );

    expect(view.summary).toBe("Release is ready.");
    expect(view.id).toBe("attempt-1");
    expect(view.subagentId).toBe("subagent-1");
    expect(JSON.stringify(view)).not.toContain("Private verification details");
  });

  test("uses the full result when there is no separate user summary", () => {
    expect(subagentActivityView(storedSubagent("Complete result.")).summary).toBe(
      "Complete result."
    );
  });

  test("keeps resumed attempts as distinct runtime records for the same child session", () => {
    const original = subagentActivityView(storedSubagent("Original result."));
    const resumed = subagentActivityView({
      ...storedSubagent("Resumed result."),
      id: "attempt-2",
      parentRunId: "parent-run-2",
      parentToolCallId: "call-2",
      childRunId: "child-run-2",
      description: "Continue the release check",
      createdAt: new Date("2026-08-27T11:00:00.000Z"),
    });

    expect([original.id, resumed.id]).toEqual(["attempt-1", "attempt-2"]);
    expect(original.subagentId).toBe(resumed.subagentId);
    expect([original.parentToolCallId, resumed.parentToolCallId]).toEqual(["call-1", "call-2"]);
    expect([original.summary, resumed.summary]).toEqual(["Original result.", "Resumed result."]);
  });

  test("projects only a stable error message", () => {
    const view = subagentActivityView(
      storedSubagent(null, {
        code: "runtime_restart",
        message: "Runtime restarted",
        internalPath: "/private/child.jsonl",
      })
    );

    expect(view.errorMessage).toBe("Runtime restarted");
    expect(JSON.stringify(view)).not.toContain("internalPath");
  });
});
