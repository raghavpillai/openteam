import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import { HostApprovalRequiredError } from "../../src/native-tool-executor";

const reason = "The user forbade Shell for this task";
function fixture(machineId?: string) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "test", "/tmp", "/tmp") as any;
  const events: any[] = [];
  const active = { runId: "run", botId: "bot", turnId: "turn", screenBotId: "screen", cwd: "/tmp", runtimeProfile: "agent", queue: { push: (e: any) => events.push(e) } };
  let reviews = 0, executions = 0, unavailable = false;
  const review = async (_: unknown, _signal: unknown, approvals: any = {}) => {
    if (approvals.autoReviewApproval) return;
    reviews++;
    if (unavailable) throw new Error("Auto Review failed closed: unavailable");
    throw new HostApprovalRequiredError({ gate: "auto-review", requestMethod: "openteam/autoReview", details: { reason, command: "echo fixture" } });
  };
  tools.processSecrets = async () => ({});
  tools.nativeToolExecutor = {
    shellWorkingDirectory: async (input: any) => input.working_directory ?? "/tmp",
    autoReviewAction: review,
    shell: async () => { executions++; return { content: [], details: {} }; },
    externalShell: async (input: any, signal: any, approvals: any) => { await review(input, signal, approvals); executions++; return { content: [], details: {} }; },
  };
  const invoke = (extra: any = {}, turn = active) => tools.executeScopedTool(turn, crypto.randomUUID(), "Shell", { command: "echo fixture", ...(machineId ? { machineId } : {}), ...extra });
  return { tools, active, events, invoke, counts: () => ({ reviews, executions }), unavailable: () => { unavailable = true; } };
}
const retry = { request_smart_mode_approval: true, smart_mode_block_reason: reason };
for (const machineId of [undefined, "mac-fixture"]) {
  test(`Shell first block returns to agent without a user wait (${machineId ?? "box"})`, async () => {
    const f = fixture(machineId);
    await expect(f.invoke()).rejects.toThrow(`Block reason: ${reason}`);
    expect(f.events).toEqual([]);
    expect(f.tools.pendingApprovals.size).toBe(0);
    expect(f.counts()).toEqual({ reviews: 1, executions: 0 });
  });
  for (const decision of ["accept", "decline"] as const)
    test(`explicit exact Shell retry ${decision}, no classifier repeat (${machineId ?? "box"})`, async () => {
      const f = fixture(machineId);
      await expect(f.invoke()).rejects.toThrow("Auto-review blocked");
      const pending = f.invoke(retry);
      const outcome = pending.then(() => "executed", (e: Error) => e.message);
      for (let i=0; i<20 && !f.events.length; i++) await Bun.sleep(1);
      expect(f.events).toHaveLength(1);
      expect(f.events[0].details.reason).toBe(reason);
      expect(f.counts()).toEqual({ reviews: 1, executions: 0 });
      f.tools.resolveApproval(f.events[0].approvalId, decision);
      expect(await outcome).toContain(decision === "accept" ? "executed" : "Do not retry");
      expect(f.counts()).toEqual({ reviews: 1, executions: decision === "accept" ? 1 : 0 });
      await expect(f.invoke(retry)).rejects.toThrow("No matching prior Shell block");
      expect(f.events).toHaveLength(1);
    });
}
for (const changed of [ { command: "echo different" }, { working_directory: "/other" }, { machineId: "other" }, { smart_mode_block_reason: "forged" } ])
  test(`changed Shell approval identity is rejected: ${JSON.stringify(changed)}`, async () => {
    const f = fixture(); await expect(f.invoke()).rejects.toThrow("blocked");
    await expect(f.invoke({ ...retry, ...changed })).rejects.toThrow("No matching prior");
    expect(f.events).toHaveLength(0); expect(f.counts().executions).toBe(0);
  });
test("forged, cross-turn, and unavailable-review retries cannot open an approval", async () => {
  const f = fixture(); await expect(f.invoke(retry)).rejects.toThrow("No matching prior");
  await expect(f.invoke()).rejects.toThrow("blocked");
  await expect(f.invoke(retry, { ...f.active, runId: "other" })).rejects.toThrow("No matching prior");
  f.unavailable(); await expect(f.invoke()).rejects.toThrow("failed closed");
  await expect(f.invoke(retry)).rejects.toThrow("No matching prior");
  expect(f.events).toHaveLength(0); expect(f.counts().executions).toBe(0);
});
test("cancelling an explicit approval never executes or preserves its receipt", async () => {
  const f = fixture(); await expect(f.invoke()).rejects.toThrow("blocked");
  const outcome = f.invoke(retry).catch((e: Error) => e.message);
  for (let i=0;i<20 && !f.events.length;i++) await Bun.sleep(1);
  f.tools.cancelApprovals(f.active.runId);
  expect(await outcome).toContain("run ended");
  expect(f.tools.pendingApprovals.size).toBe(0);
  expect(f.counts().executions).toBe(0);
  await expect(f.invoke(retry)).rejects.toThrow("No matching prior");
});
test("parallel blocks retain separate command-bound receipts", async () => {
  const f = fixture();
  const errors = await Promise.all([f.invoke(), f.invoke({ command: "echo second" })].map(p => p.catch((e: Error) => e.message)));
  expect(errors.every(x => x.includes("Block reason:"))).toBe(true);
  for (const command of ["echo fixture", "echo second"]) {
    const n = f.events.length;
    const outcome = f.invoke({ ...retry, command }).catch((e: Error) => e.message);
    for (let i=0;i<20 && f.events.length===n;i++) await Bun.sleep(1);
    expect(f.events.length).toBe(n+1);
    f.tools.resolveApproval(f.events[n].approvalId, "decline");
    await outcome;
  }
  expect(f.counts()).toEqual({ reviews: 2, executions: 0 });
});
test("intervening command execution invalidates old review context", async () => {
  const f = fixture(); await expect(f.invoke()).rejects.toThrow("blocked");
  f.tools.nativeToolExecutor.autoReviewAction = async () => {};
  await f.invoke({ command: "cd /other" });
  await expect(f.invoke(retry)).rejects.toThrow("No matching prior");
  expect(f.events).toHaveLength(0);
  expect(f.counts().executions).toBe(1);
});
