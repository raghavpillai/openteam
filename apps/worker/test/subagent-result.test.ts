import { expect, test } from "bun:test";
import { WakeWorker } from "../src/worker";

test("completion delivers the worker's own final report without a tool-failure dump", async () => {
  const writes: any[] = [];
  let delivered: string | undefined;
  let failureQuery = false;
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async (...args: any[]) => { delivered = args[3]; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", status: "running" }), updateMany: async (arg: any) => { writes.push(arg); return { count: 1 }; } },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { writes.push(arg); return {}; } },
    message: { findFirst: async () => ({ content: "  Done. The first click missed, the retry worked.\n" }) },
    runItem: { findMany: async () => { failureQuery = true; return [{ kind: "tool", content: { tool: "browser_click", result: { content: [{ type: "text", text: "Target detached" }] } } }]; } },
    event: { create: async () => {} },
  };
  await worker.completeSubagent(tx, { botId: "bot", runId: "child-run" });
  expect(failureQuery).toBe(false);
  expect(writes).toHaveLength(2);
  expect(writes[0].data.status).toBe("completed");
  expect(writes[0].data.result).toBe("Done. The first click missed, the retry worked.");
  expect(writes[1].data.result).toBe(writes[0].data.result);
  expect(delivered).toBe(writes[0].data.result);
});

test("a completion that loses the race with a parent's message leaves the worker on its new turn", async () => {
  let delivered = false;
  const attemptWrites: any[] = [];
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async () => { delivered = true; };
  // Read before the message moved the worker to a new turn; written after it committed.
  const tx = {
    subagent: {
      findFirst: async () => ({ id: "child", status: "running" }),
      update: async () => { throw new Error("unconditional completion"); },
      updateMany: async ({ where }: any) => ({ count: where.currentRunId === "steer-run" ? 1 : 0 }),
    },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { attemptWrites.push(arg); return {}; } },
    message: { findFirst: async () => ({ content: "Done." }) },
    event: { create: async () => {} },
  };
  await worker.completeSubagent(tx, { botId: "bot", runId: "child-run" });
  expect(delivered).toBe(false);
  expect(attemptWrites).toEqual([]);
});
