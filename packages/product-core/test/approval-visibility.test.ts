import { expect, test } from "bun:test";
import type { ApprovalView, RunView } from "@openteam/contracts";
import { approvalsForChannel } from "../src/activity";
test("approval visibility includes completed parent and child asks while excluding other conversations", () => {
  const runs = [
    { id: "parent", channelId: "here", conversationId: "conversation", status: "completed" },
    { id: "other", channelId: "elsewhere", conversationId: "another", status: "running" },
  ] as RunView[];
  const asks = [
    { id: "main", runId: "parent", status: "accepted" },
    { id: "child", runId: "child-run", parentRunId: "parent", status: "pending" },
    { id: "owner", runId: "older-run", ownerConversationId: "conversation", status: "expired" },
    { id: "other", runId: "other", ownerConversationId: "another", status: "pending" },
  ].map((approval) => ({
    runItemId: null, kind: "command", details: {}, createdAt: "2026-09-16T00:00:00.000Z",
    ownerConversationId: "none", parentRunId: "none", parentToolCallId: null, subagentId: null,
    ...approval,
  })) satisfies ApprovalView[];
  expect(approvalsForChannel("here", runs, asks).map((approval) => approval.id)).toEqual([
    "main",
    "child",
    "owner",
  ]);
  expect(approvalsForChannel("missing", runs, asks)).toEqual([]);
});
