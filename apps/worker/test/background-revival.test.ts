import { expect, test } from "bun:test";
import { renderRevivalBatchPrompt } from "@openteam/messaging";
import { groupRoomRevivalNote, revivalBatch, WakeWorker } from "../src/worker";

test("background subagent completion revives the parent with Bot's dedicated source", async () => {
  const calls: unknown[] = [];
  const worker = Object.create(WakeWorker.prototype) as {
    notifySubagentParent: (...args: unknown[]) => Promise<void>;
  };
  Object.assign(worker, {
    prisma: {
      bot: {
        findUnique: async () => ({ id: "parent", status: "active" }),
      },
    },
    messaging: {
      enqueueWake: async (_tx: unknown, input: unknown) => {
        calls.push(input);
        return {};
      },
    },
  });

  await worker.notifySubagentParent(
    {
      run: {
        findFirst: async () => ({ origin: "user" }),
        findUnique: async () => ({ inboxEvents: [] }),
      },
      channel: { findUnique: async () => ({ kind: "direct", name: "Parent" }) },
      bot: {
        findUnique: async () => ({ id: "parent", status: "active" }),
      },
    } as never,
    {
      id: "subagent-1",
      parentBotId: "parent",
      parentRunId: "parent-run-1",
      parentChannelId: "channel-1",
      description: "Check release",
      subagentType: "executor",
      currentRunId: "child-run-1",
      outputPath: "/tmp/result.jsonl",
    },
    "completed",
    "Release checks passed."
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    botId: "parent",
    channelId: "channel-1",
    origin: "background_revival",
    type: "subagent.completed",
    priority: 260,
    wrapUserContent: false,
    revival: { block: 'Background task "Check release" (executor) finished:\nRelease checks passed.', subagentType: "executor" },
  });
});

test("results ready together in one channel are claimed as one revival, and late ones are marked", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const wake = (id: string, secondsAgo: number, overrides: Record<string, unknown> = {}) => ({
    id,
    type: "subagent.completed",
    status: "pending",
    createdAt: new Date(now - secondsAgo * 1000),
    payload: { content: `single ${id}`, revival: { block: `block ${id}`, subagentType: "executor" } },
    run: { origin: "background_revival" as const, channelId: "dm" },
    ...overrides,
  });
  const first = wake("a", 5);
  const shell = wake("b", 20, { type: "shell.completed", payload: { revival: { block: "block b", subagentType: "shell" } } });
  const others = [
    wake("user", 1, { type: "message.user" }),
    wake("room", 2, { run: { origin: "background_revival", channelId: "room" } }),
    wake("routine", 3, { run: { origin: "routine", channelId: "dm" } }),
    wake("old-format", 4, { payload: { content: "single" } }),
    wake("taken", 4, { status: "processing" }),
  ];
  const batch = revivalBatch(first, [first, ...others, shell], now);
  expect(batch?.folded.map((folded) => folded.id)).toEqual(["b"]);
  expect(batch?.content).toBe(renderRevivalBatchPrompt([
    { block: "block b", subagentType: "shell" },
    { block: "block a", subagentType: "executor" },
  ]));
  // A lone result that came at once keeps its own prompt; one that waited a minute says so.
  expect(revivalBatch(first, [first, ...others], now)).toBeNull();
  const late = wake("late", 7 * 60);
  expect(revivalBatch(late, [late], now)?.content).toContain('block late\n(This finished about 7 minutes ago and reached you only now, so it may be out of date.)');
  expect(revivalBatch(others[0]!, [first, shell], now)).toBeNull();
  // A claim retried after a lost lease keeps the content it was given the first time.
  expect(revivalBatch({ ...first, status: "processing" }, [shell], now)).toBeNull();
});

test("a background result from a group room keeps its room note in the batch", async () => {
  const calls: Array<{ revival?: { note?: string }; content: string }> = [];
  const worker = Object.create(WakeWorker.prototype) as { notifySubagentParent: (...args: unknown[]) => Promise<void> };
  Object.assign(worker, { messaging: { enqueueWake: async (_tx: unknown, input: never) => { calls.push(input); return {}; } } });
  await worker.notifySubagentParent(
    {
      run: { findFirst: async () => ({ origin: "user" }), findUnique: async () => ({ inboxEvents: [] }) },
      channel: { findUnique: async () => ({ kind: "group", name: "Launch" }) },
      bot: { findUnique: async () => ({ id: "parent", status: "active" }) },
    } as never,
    { id: "s", parentBotId: "parent", parentRunId: "r", parentChannelId: "room", description: "Draft", subagentType: "executor", currentRunId: "c", outputPath: "/tmp/x" },
    "failed",
    "Timed out."
  );
  expect(calls[0]?.revival?.note).toBe(groupRoomRevivalNote("Launch"));
  expect(calls[0]?.content).toEndWith(`\n\n${groupRoomRevivalNote("Launch")}`);
});
