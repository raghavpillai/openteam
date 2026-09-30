import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import { ComputerRuntime } from "../../src/runtime";

test("foreground coordinator receives the blocker without waiting for its worker approval", async () => {
  const { tools, child, events, decision } = fixture();
  const coordinator = { ...child, runtimeProfile: "agent", subagentType: null };
  let executions = 0;
  // Parallel side effects must all settle so the next model turn can choose
  // a control operation such as StopSubagent. One waiting call blocks the batch.
  const calls = [1, 2].map(() => tools.assertNoPendingReview(coordinator)
    .then(() => { executions++; return "allowed"; }, (error: Error) => error.message));
  const result = await Promise.race([Promise.all(calls), Bun.sleep(100).then(() => "still waiting")]);
  const pendingCount = tools.pendingApprovals.size;
  tools.resolveApproval(events[0].approvalId, "decline");
  await decision;
  await Promise.all(calls);
  expect(result).not.toBe("still waiting");
  expect(result).toEqual([expect.stringContaining("not executed"), expect.stringContaining("not executed")]);
  expect(result).toEqual([expect.stringContaining("cursor.StopSubagent remains available"), expect.stringContaining("MessageSubagent and side effects are blocked")]);
  expect(executions).toBe(0);
  expect(pendingCount).toBe(1);
  expect(tools.shellWaits.size).toBe(0);
});

const fixture = () => {
  const events: any[] = [];
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "test-control", "/tmp", "/tmp") as any;
  const owner = { runId: "parent", screenBotId: "screen-a", runtimeProfile: "agent", queue: { push: (e: any) => events.push(e) } };
  const child = { runId: "child", screenBotId: "screen-a", runtimeProfile: "subagent" };
  const decision = tools.requestHostApproval(owner, "approval-call", { approval: { requestMethod: "test", details: {} } });
  return { tools, owner, child, events, decision };
};

test("sibling waits without executing and does not inherit another turn's approval", async () => {
  const { tools, owner, child, events, decision } = fixture();
  let settled = false;
  const waiting = tools.assertNoPendingReview(child).then(() => "unexpectedly allowed", (error: Error) => error.message).finally(() => { settled = true; });
  await Bun.sleep(10);
  expect(settled).toBe(false);
  await expect(tools.assertNoPendingReview(owner)).rejects.toThrow("waiting for approval");
  await expect(tools.assertNoPendingReview({ ...child, screenBotId: "screen-b" })).resolves.toBeUndefined();
  tools.resolveApproval(events[0].approvalId, "accept");
  expect(await decision).toBe("accept");
  expect(await waiting).toContain("This action was not executed");
  expect(events).toHaveLength(1);
});

test("cancelling a sibling wait leaves the parent's approval pending", async () => {
  const { tools, child, events, decision } = fixture();
  const controller = new AbortController();
  const waiting = tools.assertNoPendingReview(child, controller.signal).catch((error: Error) => error);
  controller.abort(new Error("worker stopped"));
  expect((await waiting).message).toBe("worker stopped");
  expect(tools.pendingApprovals.size).toBe(1);
  tools.resolveApproval(events[0].approvalId, "decline");
  expect(await decision).toBe("decline");
});

test("owner cancellation releases sibling wait without executing its old action", async () => {
  const { tools, child, decision } = fixture();
  const result = decision.catch((error: Error) => error.message);
  const waiting = tools.assertNoPendingReview(child).catch((error: Error) => error.message);
  tools.cancelApprovals("parent");
  expect(await result).toContain("run ended");
  expect(await waiting).toContain("This action was not executed");
  expect(tools.pendingApprovals.size).toBe(0);
});

test("new instructions interrupt a sibling approval wait without approving the owner", async () => {
  const { tools, child, events, decision } = fixture();
  const waiting = tools.assertNoPendingReview(child).catch((error: Error) => error.message);
  tools.interruptShellWaits(child.runId);
  const result = await Promise.race([waiting, Bun.sleep(100).then(() => "still waiting")]);
  // Always release the fixture, including when testing the unfixed implementation.
  const pendingCount = tools.pendingApprovals.size;
  tools.resolveApproval(events[0].approvalId, "decline");
  await decision;
  await waiting;
  expect(result).toContain("new user message");
  expect(pendingCount).toBe(1);
  expect(tools.shellWaits.size).toBe(0);
});

test("instructions queued before a sibling wait prevent starting that wait", async () => {
  const { tools, child, events, decision } = fixture();
  const waiting = tools.assertNoPendingReview({ ...child, pendingSteers: [{ content: "Stop" }] })
    .catch((error: Error) => error.message);
  const result = await Promise.race([waiting, Bun.sleep(100).then(() => "still waiting")]);
  tools.resolveApproval(events[0].approvalId, "decline");
  await decision;
  await waiting;
  expect(result).toContain("newer instruction");
});

test("runtime steering wakes all sibling-gated calls so the queued correction can drain", async () => {
  const { tools, child, events, decision } = fixture();
  const runtime = new ComputerRuntime() as any;
  runtime.tools = tools;
  const prompts: string[] = [];
  const active = { ...child, pendingSteers: [], acceptedSteerIds: new Set(),
    session: { isStreaming: true, prompt: async (content: string) => { prompts.push(content); } } };
  runtime.activeByRun.set(child.runId, active);
  let executions = 0;
  const wait = () => tools.assertNoPendingReview(active).then(() => { executions++; }, (e: Error) => e.message);
  const calls = [wait(), wait()];
  await runtime.steer(child.runId, { inboxId: "correction", clientMessageId: "message", content: "Stop the worker and report the blocker" });
  expect(await Promise.all(calls)).toEqual(["A new user message arrived", "A new user message arrived"]);
  expect(prompts).toEqual(["Stop the worker and report the blocker"]);
  expect(active.pendingSteers).toHaveLength(1);
  expect(executions).toBe(0);
  expect(tools.pendingApprovals.size).toBe(1);
  expect(tools.shellWaits.size).toBe(0);
  tools.resolveApproval(events[0].approvalId, "decline");
  await decision;
});
