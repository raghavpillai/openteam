import { describe, expect, test } from "bun:test";
import type { ApprovalView, RunView, SubagentActivityView } from "@openteam/contracts";
import { conversationApprovals } from "../src/renderer/lib/subagent-activity";

describe("subagent activity projection", () => {
  test("has no inline Task-card renderer in the conversation", async () => {
    const source = await Bun.file(
      new URL("../src/renderer/components/openteam/chat-pane.tsx", import.meta.url)
    ).text();
    expect(source).not.toContain("TaskCard");
    expect(source).not.toContain("data-subagent-attempt-id");
    expect(source).not.toContain('entry.type === "task"');
    expect(source).toContain('entry.type === "approval"');
    expect(source).not.toContain("...subagents.map");
  });

  test("keeps child approvals actionable without rendering a Task card", () => {
    const parentRun = { id: "parent-run" } as RunView;
    const child = { currentRunId: "child-run" } as SubagentActivityView;
    const parentApproval = {
      id: "parent-approval",
      runId: "parent-run",
      status: "pending",
      createdAt: "2026-08-27T10:00:00.000Z",
    } as ApprovalView;
    const childApproval = {
      id: "child-approval",
      runId: "child-run",
      status: "pending",
      createdAt: "2026-08-27T10:01:00.000Z",
    } as ApprovalView;
    const resolvedChildApproval = {
      id: "resolved-child-approval",
      runId: "child-run",
      status: "accepted",
      createdAt: "2026-08-27T10:02:00.000Z",
    } as ApprovalView;

    expect(
      conversationApprovals(
        [parentRun],
        [child],
        new Map([
          ["parent-run", [parentApproval]],
          ["child-run", [childApproval, resolvedChildApproval]],
        ])
      )
    ).toEqual([parentApproval, childApproval, resolvedChildApproval]);
  });
});
