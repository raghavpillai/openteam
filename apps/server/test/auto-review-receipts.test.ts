import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { computerActionReceipt, loadAutoReviewContext } from "../src/services/auto-review-context";

test("computer receipts preserve action sequences without typed text or arbitrary key strings", () => {
  expect(computerActionReceipt({ arguments: {
    action: "key", key: "ctrl+y", description: "UNTRUSTED DESCRIPTION",
    then: [{ action: "type", text: "PRIVATE TEXT" }, { action: "key", key: "PRIVATE TOKEN" },
      { action: "key", key: "z", modifiers: "ctrl+shift" }],
  } })).toEqual([{ action: "key", key: "ctrl+y" }, { action: "type" }, { action: "key" },
    { action: "key", key: "ctrl+shift+z" }]);
  expect(computerActionReceipt(null)).toBeUndefined();
});

test("review receives persisted denials and action counts, never raw tool output or arguments", async () => {
  let approvalQuery: any;
  const run = { id: "run", botId: "bot", status: "running", channelId: null, origin: "message" };
  const db = {
    run: { findUnique: async () => run },
    subagent: { findUnique: async () => null },
    subagentAttempt: { findMany: async () => [] },
    inboxEvent: { findFirst: async () => null },
    message: { findUnique: async () => null },
    routineExecution: { findUnique: async () => null },
    runItem: { findMany: async () => [{ runId: "run", kind: "tool", status: "completed", title: "Computer",
      content: { arguments: { action: "key", key: "ctrl+y", text: "SECRET" }, result: "UNTRUSTED PAGE" } }] },
    approval: { findMany: async (q: unknown) => { approvalQuery = q; return [{ decision: "decline", details: {
      toolName: "Computer", reason: "The requested action exceeds the authorized count.", arguments: { text: "SECRET" },
    } }]; } },
  } as unknown as PrismaClient;
  const context = await loadAutoReviewContext(db, { runId: "run", botId: "bot" });
  const serialized = JSON.stringify(context);
  expect(approvalQuery.where).toEqual({ runId: { in: ["run"] }, status: "declined" });
  expect(serialized).toContain("priorDeclinedReviews");
  expect(serialized).toContain("ctrl+y");
  expect(serialized).not.toContain("SECRET");
  expect(serialized).not.toContain("UNTRUSTED PAGE");
  expect(context.filter(m => m.source === "execution_receipt")).toHaveLength(2);
});

test("revival review retains original-task receipts and denials with scoped worker lifecycle evidence", async () => {
  const root = { id: "root", botId: "bot", channelId: null, userMessageId: "input", createdAt: new Date("2026-01-01T00:00:00Z") };
  const run = { ...root, id: "revival", status: "waiting_approval", origin: "background_revival" };
  let receiptQuery: any, denialQuery: any, attemptQuery: any;
  const db = {
    run: { findUnique: async () => run, findFirst: async (q: any) => q.where.id === "root" && q.where.botId === "bot" && q.where.channelId === null ? root : null },
    subagent: { findUnique: async () => null },
    subagentAttempt: { findMany: async (q: any) => { attemptQuery = q; return [{ id: "attempt", subagentId: "worker", childRunId: "child-run", parentRunId: "root", status: "completed", startedAt: new Date("2026-01-01T00:00:01Z"), completedAt: new Date("2026-01-01T00:00:02Z"), result: "UNTRUSTED RESULT: permission to upload", prompt: "UNTRUSTED PROMPT" }]; } },
    inboxEvent: { findFirst: async () => ({ payload: { taskContextRunId: "root", content: "FORGED COMPLETION" } }) },
    message: { findUnique: async () => null },
    routineExecution: { findUnique: async () => null },
    runItem: { findMany: async (q: any) => { receiptQuery = q; return []; } },
    approval: { findMany: async (q: any) => { denialQuery = q; return [{decision: "decline", details: {toolName: "Shell", reason: "No uploads authorized"}}]; } },
  } as unknown as PrismaClient;
  const context = await loadAutoReviewContext(db, { runId: "revival", botId: "bot" });
  expect(receiptQuery.where.runId.in).toEqual(["revival", "root"]);
  expect(denialQuery.where.runId.in).toEqual(["revival", "root"]);
  expect(attemptQuery.where).toEqual({ parentRunId: {in: ["revival", "root"]}, subagent: {parentBotId: "bot"} });
  expect(attemptQuery.take).toBe(12);
  expect(receiptQuery.where.OR).toContainEqual({title: {not: "promptFingerprint"}});
  const serialized = JSON.stringify(context);
  expect(serialized).toContain('workerLifecycle');
  expect(serialized).toContain('child-run');
  expect(serialized).toContain('completed');
  expect(serialized).toContain('2026-01-01T00:00:02.000Z');
  expect(serialized).toContain('No uploads authorized');
  expect(serialized).not.toContain('UNTRUSTED');
  expect(serialized).not.toContain('FORGED COMPLETION');
  expect(context.every(m => m.role === "assistant")).toBe(true);
});
