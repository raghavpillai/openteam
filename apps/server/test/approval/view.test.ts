import { describe, expect, test } from "bun:test";
import { approvalViews } from "../../src/services/approval-view";

const approval = (runId: string) => ({
  id: `approval-${runId}`,
  runId,
  runItemId: null,
  kind: "command",
  status: "pending",
  details: { command: "pwd" },
  createdAt: new Date("2026-08-27T10:00:00.000Z"),
});

describe("approval ownership projection", () => {
  test("owns a child approval by the parent conversation and Task attempt", () => {
    const [view] = approvalViews(
      [approval("child-run")],
      [
        { id: "parent-run", conversationId: "parent-conversation" },
        { id: "child-run", conversationId: "child-conversation" },
      ],
      [
        {
          parentRunId: "parent-run",
          parentToolCallId: "task-resume-call",
          childRunId: "child-run",
          subagent: { id: "sand-subagent" },
        },
      ]
    );

    expect(view).toMatchObject({
      runId: "child-run",
      ownerConversationId: "parent-conversation",
      parentRunId: "parent-run",
      parentToolCallId: "task-resume-call",
      subagentId: "sand-subagent",
    });
  });

  test("keeps a direct approval on its own parent run", () => {
    const [view] = approvalViews(
      [approval("parent-run")],
      [{ id: "parent-run", conversationId: "parent-conversation" }],
      []
    );

    expect(view).toMatchObject({
      ownerConversationId: "parent-conversation",
      parentRunId: "parent-run",
      parentToolCallId: null,
      subagentId: null,
    });
  });
});
