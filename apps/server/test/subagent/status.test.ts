import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";

function fixture(runStatus = "waiting_approval", linkedRun = "current") {
  const child = { id: "child", parentBotId: "parent", childBotId: "child-bot", currentRunId: linkedRun,
    status: "running", description: "Upload receipt", subagentType: "computerUse", createdAt: new Date(),
    startedAt: new Date(), completedAt: null, stoppedAt: null, outputPath: "/tmp/transcript", result: null, error: null };
  let approvalReads = 0;
  const approvals: Array<{ id: string; runId: string; status: string; details: Record<string, unknown> }> = [
    { id: "old", runId: "old", status: "pending", details: { reason: "Old attempt" } },
    { id: "pending", runId: "current", status: "pending", details: { summary: "Computer", reason: "Approve upload", arguments: { private: "not exposed" } } },
    { id: "resolved", runId: "current", status: "accepted", details: { reason: "Resolved" } },
    { id: "foreign", runId: "foreign", status: "pending", details: { reason: "Other bot" } },
  ];
  const db = {
    subagent: {
      findFirst: async ({ where }: any) => where.id === child.id && where.parentBotId === child.parentBotId ? child : null,
      findMany: async ({ where }: any) => where.parentBotId === child.parentBotId ? [child] : [],
    },
    run: { findFirst: async ({ where }: any) => where.id === "current" && where.botId === "child-bot" ? { id: "current", status: runStatus } : null },
    approval: { findMany: async ({ where, take, select }: any) => {
      approvalReads++;
      expect(select).toEqual({ id: true, details: true });
      return approvals.filter(a => a.runId === where.runId && a.status === where.status).slice(0, take);
    } },
    runItem: { findMany: async () => [], count: async () => 0 },
  };
  const service = new SubagentService(db as never, {} as never, {} as never, "/workspace", {} as never, {} as never);
  return { service, child, approvals, reads: () => approvalReads };
}

test("owned running worker exposes actual waiting state and only current pending approval", async () => {
  const { service } = fixture();
  const result = await service.check("parent", { subagent_id: "sand-subagent-child" });
  expect(result).toMatchObject({ status: "running", run_status: "waiting_approval", pending_approvals: [{ id: "pending", summary: "Computer", reason: "Approve upload" }] });
  expect(JSON.stringify(result)).not.toContain("not exposed");
  expect(JSON.stringify(result)).not.toContain("Old attempt");
});

test("completed child run never advertises lingering pending approvals", async () => {
  const { service, reads } = fixture("completed");
  expect(await service.check("parent", { subagent_id: "child" })).toMatchObject({ run_status: "completed", pending_approvals: [] });
  expect(reads()).toBe(0);
});

test("another parent cannot inspect the child or its approval", async () => {
  const { service, reads } = fixture();
  expect(typeof await service.check("other-parent", { subagent_id: "child" })).toBe("string");
  expect(reads()).toBe(0);
});

test("unavailable or foreign current run cannot expose any approval", async () => {
  const { service, reads } = fixture("waiting_approval", "foreign");
  expect(await service.check("parent", { subagent_id: "child" })).toMatchObject({ run_status: null, pending_approvals: [], tool_call_count: 0 });
  expect(reads()).toBe(0);
});

test("list status includes blocked worker and bounds approval count and text", async () => {
  const { service, approvals } = fixture();
  for (let i = 0; i < 12; i++) approvals.push({ id: `p${i}`, runId: "current", status: "pending", details: { reason: "r".repeat(1000), summary: "s".repeat(1000) } });
  const result = await service.check("parent", {}) as any;
  expect(result.subagents[0].run_status).toBe("waiting_approval");
  expect(result.subagents[0].pending_approvals).toHaveLength(8);
  expect(result.subagents[0].pending_approvals[1].reason).toHaveLength(500);
  expect(result.subagents[0].pending_approvals[1].summary).toHaveLength(500);
});
