import { expect, test } from "bun:test";
import { finalizeInterruptedItems } from "../src/interrupted-progress";
import { WakeWorker } from "../src/worker";

const completed = { kind: "tool", status: "completed", content: { tool: "browser_snapshot", result: { details: { path: "/workspace/shared/screenshots/progress.png" }, content: [{ type: "text", text: "Completed (3/5): text, replacement, nested" }] } } };
const pending = { id: "item", upstreamItemId: "click", kind: "tool", status: "running", content: { tool: "browser_click", status: "inProgress" } };

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

const failWorker = async (details: Record<string, unknown>, interrupted: boolean) => {
  const writes: any[] = [];
  let delivered: any;
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async (...args: any[]) => { delivered = args[3]; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", status: "running" }), updateMany: async (arg: any) => { writes.push(arg); return { count: 1 }; } },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { writes.push(arg); return {}; } },
    runItem: { findMany: async () => [pending, completed] },
    event: { create: async () => {} },
  };
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, details, interrupted);
  expect(writes).toHaveLength(2);
  expect(writes[1].data.result).toBe(writes[0].data.result);
  expect(delivered).toBe(writes[0].data.result);
  return delivered;
};

test("an interrupted worker reports the reference's interruption line and no progress dump", async () => {
  expect(await failWorker({ message: "terminated" }, true)).toBe("The background task was interrupted before it finished.");
});

test("a worker that failed reports its error message as is", async () => {
  expect(await failWorker({ code: "runtime_interrupted", message: "Model provider returned 500" }, false)).toBe("Model provider returned 500");
});

test("a failure that loses the race with a parent's message leaves the worker on its new turn", async () => {
  let delivered = false;
  const attemptWrites: any[] = [];
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async () => { delivered = true; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", status: "running" }), updateMany: async ({ where }: any) => ({ count: where.currentRunId === "steer-run" ? 1 : 0 }) },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { attemptWrites.push(arg); return {}; } },
    runItem: { findMany: async () => [] },
    event: { create: async () => {} },
  };
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, { message: "terminated" }, true);
  expect(delivered).toBe(false);
  expect(attemptWrites).toEqual([]);
});
