import { describe, expect, test } from "bun:test";
import type { SubagentActivityView } from "@openteam/contracts";
import { activeAsyncTasksForBot, asyncTaskElapsed } from "../src/renderer/lib/async-tasks";

const attempt = (overrides: Partial<SubagentActivityView> = {}): SubagentActivityView => ({
  id: "attempt-1",
  subagentId: "child-1",
  parentBotId: "parent-1",
  parentRunId: "parent-run-1",
  parentChannelId: "channel-1",
  parentToolCallId: "task-call-1",
  currentRunId: "child-run-1",
  description: "Check the release",
  subagentType: "executor",
  status: "running",
  summary: null,
  errorMessage: null,
  startedAt: "2026-08-27T10:00:00.000Z",
  completedAt: null,
  stoppedAt: null,
  createdAt: "2026-08-27T09:59:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
  ...overrides,
});

describe("OpenTeam-compatible async-task overlay", () => {
  test("lists only active children owned by the selected parent", () => {
    expect(
      activeAsyncTasksForBot(
        [
          attempt(),
          attempt({ id: "completed", subagentId: "child-2", status: "completed" }),
          attempt({ id: "other-parent", subagentId: "child-3", parentBotId: "parent-2" }),
        ],
        "parent-1"
      ).map((task) => task.id)
    ).toEqual(["attempt-1"]);
  });

  test("keys the live row by child session when a resume creates a new attempt", () => {
    const original = attempt({ status: "completed" });
    const resumed = attempt({
      id: "attempt-2",
      parentRunId: "parent-run-2",
      parentToolCallId: "task-call-2",
      currentRunId: "child-run-2",
      description: "Recheck the release",
      status: "queued",
      startedAt: null,
      createdAt: "2026-08-27T11:00:00.000Z",
      updatedAt: "2026-08-27T11:00:00.000Z",
    });

    expect(activeAsyncTasksForBot([original, resumed], "parent-1")).toEqual([resumed]);
  });

  test("uses compact elapsed time labels", () => {
    const task = attempt();
    expect(asyncTaskElapsed(task, Date.parse("2026-08-27T10:00:42.000Z"))).toBe("42s");
    expect(asyncTaskElapsed(task, Date.parse("2026-08-27T10:12:00.000Z"))).toBe("12m");
    expect(asyncTaskElapsed(task, Date.parse("2026-08-27T13:00:00.000Z"))).toBe("3h");
  });
});
