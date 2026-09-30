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
    runItem: { findMany: async (_args?: any): Promise<any[]> => [], count: async (_args?: any) => 0 },
  };
  const service = new SubagentService(db as never, {} as never, {} as never, "/workspace", {} as never, {} as never);
  return { service, child, approvals, db, reads: () => approvalReads };
}

test("failed worker calls expose bounded result text without arguments or successful output", async () => {
  const { service, db } = fixture("running");
  const reason = "A newer instruction is queued. This tool action was not executed. Process the new instruction before choosing the next action.";
  db.runItem.findMany = async () => [
    { title: "browser_select_option", status: "failed", createdAt: new Date(), content: {
      arguments: { private: "argument must not appear" }, result: { isError: true, content: [{ type: "text", text: reason }] },
    } },
    { title: "Shell", status: "failed", createdAt: new Date(), content: {
      result: { isError: true, content: [{ type: "image", data: "image must not appear" }, { type: "text", text: "x".repeat(1000) }] },
    } },
    { title: "Read", status: "completed", createdAt: new Date(), content: {
      result: { content: [{ type: "text", text: "successful output must not appear" }] },
    } },
    { title: "browser_click", status: "failed", createdAt: new Date(), content: null },
  ];
  const result = await service.check("parent", { subagent_id: "child" }) as any;
  expect(result.recent_tool_calls[0]).toMatchObject({ status: "failed", error: reason });
  expect(result.recent_tool_calls[1].error).toHaveLength(500);
  expect(result.recent_tool_calls[2].error).toBeUndefined();
  expect(result.recent_tool_calls[3].error).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("must not appear");
});

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

test("prompt diagnostics do not inflate worker activity or crowd out recent tool calls", async () => {
  const { service, db } = fixture("completed");
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ kind: "tool", title: "promptFingerprint", createdAt: new Date(100 + i), status: "completed" })),
    { kind: "tool", title: "browser_click", createdAt: new Date(3), status: "failed" },
    { kind: "command", title: "promptFingerprint", createdAt: new Date(2), status: "completed" },
    { kind: "tool", title: null, createdAt: new Date(1), status: "completed" },
  ];
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "runId") return true;
      if (key === "OR") return value.some((clause: any) => matches(row, clause));
      if (value && typeof value === "object") {
        if ("in" in value) return value.in.includes(row[key]);
        if ("not" in value) return row[key] !== null && row[key] !== value.not;
      }
      return row[key] === value;
    });
  db.runItem.findMany = async ({ where, take }: any) => rows.filter(row => matches(row, where))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
  db.runItem.count = async ({ where }: any) => rows.filter(row => matches(row, where)).length;
  const result = await service.check("parent", { subagent_id: "child" }) as any;
  expect(result.tool_call_count).toBe(3);
  expect(result.recent_tool_calls.map((call: any) => call.tool)).toEqual(["browser_click", "promptFingerprint", "tool"]);
});
