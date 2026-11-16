import { expect, test } from "bun:test";
import type { TaskInput } from "@openteam/contracts";
import { assertSubagentCapacity, SubagentService, subagentTaskContent, subagentTaskWake } from "../../src/services/subagent/service";

test("passes the Task prompt through as the worker's exact job", () => {
  const input: TaskInput = {
    description: "Check a page",
    prompt: "Open https://example.com and report its heading. Stop there.",
    subagent_type: "computerUse",
    file_attachments: ["/workspace/shared/reference.png"],
    run_in_background: true,
  };
  expect(subagentTaskContent(input)).toBe(input.prompt);
  expect(subagentTaskContent(input)).not.toContain("Background task");
  expect(subagentTaskContent(input)).not.toContain("user_visible_high_level_summary");
  // The wake wraps it in <timestamp> and <user_query>, as a typed turn.
  expect(subagentTaskWake(input)).toEqual({ content: input.prompt });
});

test("has no generic child pool cap and locks only computerUse per parent", async () => {
  let countCalls = 0;
  const available = {
    subagent: {
      count: async () => {
        countCalls += 1;
        return 0;
      },
    },
  };

  await assertSubagentCapacity("parent", "executor", available as never);
  await assertSubagentCapacity("parent", "knowledgeWork", available as never);
  expect(countCalls).toBe(0);
  await assertSubagentCapacity("parent", "computerUse", available as never);
  expect(countCalls).toBe(1);

  const busy = { subagent: { count: async () => 1 } };
  await expect(assertSubagentCapacity("parent", "computerUse", busy as never)).rejects.toThrow(
    "Only one can run at a time. Wait for it to finish (you're notified automatically), then dispatch another."
  );
});

test("resuming a task rechecks the parent inside the lifecycle lock", async () => {
  const locks: unknown[] = [];
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => { locks.push(...values); return 0; },
    bot: { findUnique: async () => ({ status: "archived" }) },
  };
  const db = {
    subagent: { findFirst: async () => ({ id: "child", parentBotId: "parent", subagentType: "executor", status: "completed" }) },
    $transaction: async (work: any) => work(tx),
  };
  const service = new SubagentService(db as never, {} as never, {} as never, "/unused", {} as never, {} as never) as any;
  await expect(service.resume({ botId: "parent" }, { resume: "child", prompt: "Continue", description: "Child" }))
    .rejects.toMatchObject({ code: "parent_not_active" });
  expect(locks).toContain("agent-lifecycle:parent");
});

for (const resume of [undefined, "restore-missing-worker"]) {
  test(`Task cannot select inference at the server boundary, restore=${!!resume}`, async () => {
    const configured = { providerId: "openai", modelId: "configured", reasoning: "medium" };
    const config = { executorProfiles: [
      { name: "high", description: "legacy", providerId: "openai", modelId: "expensive", reasoning: "high" },
    ], defaultExecutorProfile: "high" };
    let child: any;
    const stop = new Error("captured child persistence");
    const tx: any = {
      $executeRaw: async () => 1,
      bot: { create: async () => ({}), findUnique: async () => ({ status: "active" }) }, channel: { create: async () => ({}), findFirst: async () => ({ id: "parent-room" }) },
      run: { findUnique: async () => ({ id: "parent-run", botId: "parent", channelId: "parent-room", origin: "user", status: "running", inboxEvents: [] }), update: async () => ({}) },
      subagent: { create: async ({ data }: any) => { child = data; throw stop; } },
    };
    const db: any = {
      run: { findUnique: async () => ({ inferenceProvider: "openrouter", inferenceModel: "parent", inferenceReasoning: "low", taskConfiguration: config }) },
      bot: { findUnique: async () => ({ status: "active", name: "parent" }) },
      subagent: { findFirst: async () => null },
      $transaction: async (f: any) => f(tx),
    };
    const service = new SubagentService(db, null as any, null as any, "/workspace", null as any, {
      loadInferenceSettings: async () => configured, loadTaskConfiguration: async () => config,
    } as any) as any;
    const args = { description: "test", prompt: "test", model: "high", reasoning: "high", providerId: "attacker", subagent_type: "executor", resume };
    await expect(service[resume ? "resume" : "launch"]({ botId: "parent", runId: "parent-run" }, args)).rejects.toBe(stop);
    expect(child.model).toBe("openrouter/parent");
    expect(child.reasoning).toBe("low");
  });
}
