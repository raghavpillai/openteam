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

test("a worker whose turn the user or parent cancelled is stopped and never reports back", async () => {
  let delivered = false;
  const writes: any[] = [];
  const events: any[] = [];
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async () => { delivered = true; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", parentBotId: "parent", status: "running" }), updateMany: async (arg: any) => { writes.push(arg); return { count: 1 }; } },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { writes.push(arg); return {}; } },
    event: { create: async (arg: any) => { events.push(arg.data); } },
  };
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, { code: "cancelled_by_user", message: "Computer turn ended with status interrupted" }, true, true);
  expect(delivered).toBe(false);
  expect(writes.map((write) => write.data.status)).toEqual(["stopped", "stopped"]);
  expect(events.map((event) => event.topic)).toEqual(["subagent.stopped"]);
});

test("a turn the computer settled as stopped is cancelled even before the server records the stop, and nothing is redriven", async () => {
  const runUpdates: any[] = [];
  const wakes: any[] = [];
  let stoppedSubagent: boolean | undefined;
  const any = (overrides: Record<string, any> = {}) =>
    new Proxy(overrides, { get: (target, key) => target[key as string] ?? (async () => null) });
  const tx = new Proxy({
    run: any({
      findUnique: async () => ({ id: "run", botId: "bot", status: "running", inputDeliveredAt: new Date(), error: null }),
      update: async (arg: any) => { runUpdates.push(arg.data); return {}; },
    }),
    runItem: any({ findMany: async () => [] }),
    bot: any({ findUnique: async () => ({ id: "bot", notificationsEnabled: false }) }),
    channel: any({ findFirst: async () => ({ id: "channel", kind: "bot_dm", archivedAt: null }) }),
  } as Record<string, any>, { get: (target, key) => target[key as string] ?? any() });
  const worker = Object.create(WakeWorker.prototype) as any;
  const unused = async () => undefined;
  worker.prisma = new Proxy({ $transaction: async (fn: any) => fn(tx) }, { get: (target: any, key) => target[key] ?? any() });
  worker.messaging = { enqueueWake: async (_tx: unknown, wake: unknown) => { wakes.push(wake); }, scheduleTranscriptProjection: unused };
  worker.failSubagent = async (_tx: unknown, _claimed: unknown, _details: unknown, _interrupted: boolean, stopped: boolean) => { stoppedSubagent = stopped; };
  worker.syncRoutineRunFile = unused;
  const { TurnStoppedError } = await import("../src/worker");
  await worker.fail({ botId: "bot", runId: "run", inboxId: "inbox", ownerId: "owner", origin: "user", inboxType: "message", conversationId: "c", channelId: "channel" },
    new TurnStoppedError("Computer turn ended with status cancelled"));
  expect(runUpdates[0]?.status).toBe("cancelled");
  expect(wakes).toEqual([]);
  expect(stoppedSubagent).toBe(true);
});
