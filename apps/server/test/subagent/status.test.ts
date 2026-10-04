import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";

function fixture(runStatus = "running", linkedRun = "current") {
  const child = { id: "child", parentBotId: "parent", childBotId: "child-bot", currentRunId: linkedRun,
    status: "running", description: "Upload receipt", subagentType: "computerUse", createdAt: new Date(),
    startedAt: new Date(), completedAt: null, stoppedAt: null, outputPath: "/tmp/transcript", result: null, error: null };
  const db = {
    subagent: {
      findFirst: async ({ where }: any) => where.id === child.id && where.parentBotId === child.parentBotId ? child : null,
      findMany: async ({ where }: any) => where.parentBotId === child.parentBotId ? [child] : [],
    },
    run: { findFirst: async ({ where }: any) => where.id === "current" && where.botId === "child-bot" ? { id: "current", status: runStatus } : null },
    runItem: { findMany: async (_args?: any): Promise<any[]> => [], count: async (_args?: any) => 0 },
  };
  const service = new SubagentService(db as never, {} as never, {} as never, "/workspace", {} as never, {} as never);
  return { service, child, db };
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
});;;

test("another parent cannot inspect the child ", async () => {
  const { service } = fixture();
  expect(typeof await service.check("other-parent", { subagent_id: "child" })).toBe("string");
});

test("unavailable or foreign current run exposes no run", async () => {
  const { service } = fixture("running", "foreign");
  expect(await service.check("parent", { subagent_id: "child" })).toMatchObject({ run_status: null, tool_call_count: 0 });
});;

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
