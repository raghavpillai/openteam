import { expect, test } from "bun:test";
import { finalizeInterruptedItems } from "../src/interrupted-progress";
import { TurnStoppedError, WakeWorker } from "../src/worker";

const completed = { kind: "tool", status: "completed", content: { tool: "browser_snapshot", result: { details: { path: "/workspace/shared/screenshots/progress.png" }, content: [{ type: "text", text: "Completed (3/5): text, replacement, nested" }] } } };
const pending = { id: "item", upstreamItemId: "click", kind: "tool", status: "running", content: { tool: "browser_click", status: "inProgress" } };

// A worker whose parent notification is captured, settling a running child and attempt.
const settlement = (overrides: Record<string, any> = {}) => {
  const writes: any[] = [];
  const events: any[] = [];
  const state: { delivered?: string; deliveries: number } = { deliveries: 0 };
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.notifySubagentParent = async (...args: any[]) => { state.delivered = args[3]; state.deliveries++; };
  const tx = {
    subagent: { findFirst: async () => ({ id: "child", parentBotId: "parent", status: "running" }), updateMany: async (arg: any) => { writes.push(arg); return { count: 1 }; } },
    subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async (arg: any) => { writes.push(arg); return {}; } },
    runItem: { findMany: async () => [pending, completed] },
    event: { create: async (arg: any) => { events.push(arg.data); } },
    ...overrides,
  };
  return { worker, tx, writes, events, state };
};
// Read before a parent's message moved the worker to a new turn; written after it committed.
const raced = { subagent: { findFirst: async () => ({ id: "child", status: "running" }), updateMany: async ({ where }: any) => ({ count: where.currentRunId === "steer-run" ? 1 : 0 }) } };

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

test("completion delivers the worker's own final report without a tool-failure dump", async () => {
  let failureQuery = false;
  const { worker, tx, writes, state } = settlement({
    message: { findFirst: async () => ({ content: "  Done. The first click missed, the retry worked.\n" }) },
    runItem: { findMany: async () => { failureQuery = true; return [completed]; } },
  });
  await worker.completeSubagent(tx, { botId: "bot", runId: "child-run" });
  expect(failureQuery).toBe(false);
  expect(writes).toHaveLength(2);
  expect(writes[0].data.status).toBe("completed");
  expect(writes[0].data.result).toBe("Done. The first click missed, the retry worked.");
  expect(writes[1].data.result).toBe(writes[0].data.result);
  expect(state.delivered).toBe(writes[0].data.result);
});

test.each([
  ["an interrupted worker reports the reference's interruption line and no progress dump", { message: "terminated" }, true, "The background task was interrupted before it finished."],
  ["a worker that failed reports its error message as is", { code: "runtime_interrupted", message: "Model provider returned 500" }, false, "Model provider returned 500"],
] as const)("%s", async (_name, details, interrupted, expected) => {
  const { worker, tx, writes, state } = settlement();
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, details, interrupted);
  expect(writes).toHaveLength(2);
  expect(writes[1].data.result).toBe(writes[0].data.result);
  expect(state.delivered).toBe(expected);
});

test.each(["complete", "fail"] as const)("a %s that loses the race with a parent's message leaves the worker on its new turn", async (kind) => {
  const { worker, tx, writes, state } = settlement({ ...raced, message: { findFirst: async () => ({ content: "Done." }) }, runItem: { findMany: async () => [] } });
  if (kind === "complete") await worker.completeSubagent(tx, { botId: "bot", runId: "child-run" });
  else await worker.failSubagent(tx, { botId: "bot", runId: "run" }, { message: "terminated" }, true);
  expect(state.deliveries).toBe(0);
  expect(writes).toEqual([]);
});

test("a worker whose turn the user or parent cancelled is stopped and never reports back", async () => {
  const { worker, tx, writes, events, state } = settlement();
  await worker.failSubagent(tx, { botId: "bot", runId: "run" }, { code: "cancelled_by_user", message: "Computer turn ended with status interrupted" }, true, true);
  expect(state.deliveries).toBe(0);
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
    $executeRaw: async () => 0,
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
  await worker.fail({ botId: "bot", runId: "run", inboxId: "inbox", ownerId: "owner", origin: "user", inboxType: "message", conversationId: "c", channelId: "channel" },
    new TurnStoppedError("Computer turn ended with status cancelled"));
  expect(runUpdates[0]?.status).toBe("cancelled");
  expect(wakes).toEqual([]);
  expect(stoppedSubagent).toBe(true);
});
