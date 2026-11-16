import { describe, expect, test } from "bun:test";
import { subagentActivityView } from "../../src/services/subagent/view";

const storedSubagent = (result: string | null, error: unknown = null) => ({
  id: "attempt-1",
  parentRunId: "parent-run-1",
  parentChannelId: "channel-1",
  parentToolCallId: "call-1",
  childRunId: "child-run-1",
  description: "Check the release",
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
  test("a parked task stays visible only on its current attempt and no view exposes the private result", () => {
    const row = storedSubagent("Private result");
    const waiting = subagentActivityView({ ...row, subagent: { ...row.subagent, status: "waiting", currentRunId: row.childRunId } });
    expect(waiting.status).toBe("waiting"); expect(waiting.completedAt).toBeNull(); expect(waiting.summary).toBeNull();
    expect(JSON.stringify(subagentActivityView(row))).not.toContain("Private result");
    expect(subagentActivityView({ ...row, subagent: { ...row.subagent, status: "waiting", currentRunId: "a-later-run" } }).status).toBe("completed");
  });
});
