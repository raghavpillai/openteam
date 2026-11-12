import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";

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
