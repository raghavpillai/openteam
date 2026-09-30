import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";

for (const resume of [undefined, "restore-missing-worker"]) {
  test(`Task cannot select inference at the server boundary, restore=${!!resume}`, async () => {
    const configured = { providerId: "openai", modelId: "configured", reasoning: "medium" };
    const config = { combinedComputerUse: true, executorProfiles: [
      { name: "high", description: "legacy", providerId: "openai", modelId: "expensive", reasoning: "high" },
    ], defaultExecutorProfile: "high" };
    let child: any;
    const stop = new Error("captured child persistence");
    const tx: any = {
      $executeRaw: async () => 1,
      bot: { create: async () => ({}) }, channel: { create: async () => ({}) },
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
