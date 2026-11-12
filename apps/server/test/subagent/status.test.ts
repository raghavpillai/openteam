import { expect, test } from "bun:test";
import { SubagentService, subagentActivity } from "../../src/services/subagent/service";

function fixture(runStatus = "running", linkedRun = "current") {
  const child = { id: "child", parentBotId: "parent", childBotId: "child-bot", currentRunId: linkedRun,
    status: "running", description: "Upload receipt", prompt: "Upload the receipt to the expense site", subagentType: "computerUse", createdAt: new Date(),
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

test("activity lists each call's start and end as the reference logs them, with no error text", async () => {
  const { service, db } = fixture("running");
  const at = (seconds: number) => new Date(1_000 * seconds);
  db.runItem.findMany = async () => [
    { kind: "tool", title: "WebSearch", status: "running", createdAt: at(5), startedAt: at(5) },
    { kind: "tool", title: "WebSearch", status: "failed", createdAt: at(3), startedAt: at(3), completedAt: at(4), content: {
      arguments: { private: "argument must not appear" }, result: { isError: true, content: [{ type: "text", text: "rate limited must not appear" }] },
    } },
    { kind: "command", title: "Shell", status: "completed", createdAt: at(1), startedAt: at(1), completedAt: at(2), content: {
      result: { content: [{ type: "text", text: "successful output must not appear" }] },
    } },
    { kind: "tool", title: "Read", status: "cancelled", createdAt: at(0), completedAt: at(0.5) },
  ];
  const result = await service.check("parent", { subagent_id: "child" }) as any;
  expect(result.recent_activity).toEqual([
    "[pending] Read", "[failed] Read", "[pending] Shell", "[done] Shell", "[pending] WebSearch", "[failed] WebSearch", "[pending] WebSearch",
  ]);
  expect(JSON.stringify(result)).not.toContain("must not appear");
});

test("activity collapses repeats and keeps the newest 24 entries", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: "tool", title: `t${i}`, status: "completed", createdAt: new Date(10 * i), completedAt: new Date(10 * i + 5) }));
  const activity = subagentActivity(items);
  expect(activity).toHaveLength(24);
  expect(activity[0]).toBe("[pending] t8");
  expect(activity.at(-1)).toBe("[done] t19");
  expect(subagentActivity([
    { kind: "tool", title: "Shell", status: "running", createdAt: new Date(1) },
    { kind: "tool", title: "Shell", status: "running", createdAt: new Date(2) },
  ])).toEqual(["[pending] Shell"]);
});

test("another parent, or an unavailable or foreign current run, exposes nothing", async () => {
  expect(typeof await fixture().service.check("other-parent", { subagent_id: "child" })).toBe("string");
  expect(await fixture("running", "foreign").service.check("parent", { subagent_id: "child" })).toMatchObject({ run_status: null, tool_call_count: 0 });
});
