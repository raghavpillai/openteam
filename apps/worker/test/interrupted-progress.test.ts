import { expect, test } from "bun:test";
import { finalizeInterruptedItems, interruptedProgress } from "../src/interrupted-progress";
import { WakeWorker } from "../src/worker";

const completed = { kind: "tool", status: "completed", content: { tool: "browser_snapshot", result: { details: { path: "/workspace/shared/screenshots/progress.png" }, content: [{ type: "text", text: "Completed (3/5): text, replacement, nested" }, { type: "image", data: "PRIVATE-BASE64" }] } } };
const pending = { id: "item", upstreamItemId: "click", kind: "tool", status: "running", content: { tool: "browser_click", status: "inProgress" } };

test("interruption retains evidence without images or claiming the in-flight action completed", () => {
  const result = interruptedProgress([completed, pending], "terminated");
  expect(result).toContain("Completed (3/5)");
  expect(result).toContain("Not verified");
  expect(result).toContain("/workspace/shared/screenshots/progress.png");
  expect(result).not.toContain("PRIVATE-BASE64");
});

test("unfinished items become terminal in the database and client event", async () => {
  let updated: any, event: any;
  await finalizeInterruptedItems({
    runItem: { findMany: async () => [pending], update: async (args: any) => { updated = args; } },
    event: { create: async (args: any) => { event = args; } },
  } as any, "run", false);
  expect(updated.data.status).toBe("failed");
  expect(updated.data.content.status).toBe("failed");
  expect(event.data.payload.upstreamItemId).toBe("click");
});

test("failed graphical workers persist partial results and send those results to the parent", async () => {
  const writes: any[] = [];
  let delivered: any;
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async (...args: any[]) => { delivered = args[3]; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", status: "running" }), update: async (arg: any) => writes.push(arg) },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running", runInBackground: true }), update: async (arg: any) => writes.push(arg) },
    runItem: { findMany: async () => [pending, completed] },
    event: { create: async () => {} },
  };
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, { message: "terminated" });
  expect(writes).toHaveLength(2);
  expect(writes[0].data.result).toContain("Completed (3/5)");
  expect(delivered).toBe(writes[0].data.result);
});
