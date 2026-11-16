import { expect, test } from "bun:test";
import { renderRevivalBatchPrompt } from "@openteam/messaging";
import { revivalBatch, WakeWorker } from "../src/worker";

/** Notify a parent whose run has the given origin, capturing the wake it enqueues. */
async function revive(origin: "user" | "routine", prompt: string, subagentType: string, result: string) {
  const calls: any[] = [];
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.messaging = { enqueueWake: async (_tx: unknown, input: unknown) => (calls.push(input), {}) };
  const parentRunId = "22222222-2222-4222-8222-222222222222";
  await worker.notifySubagentParent(
    {
      run: { findFirst: async () => ({ id: parentRunId, origin, inboxEvents: [{ payload: {} }] }), findUnique: async () => ({ inboxEvents: [] }) },
      automationResult: { findUnique: async () => null },
      routineExecution: { findUnique: async ({ where }: any) => (where.runId === parentRunId ? { routine: { name: "Price watch", slug: "price-watch" } } : null) },
      channel: { findUnique: async () => ({ kind: "direct", name: "Parent" }) },
      bot: { findUnique: async () => ({ id: "parent", status: "active" }) },
    },
    { id: "subagent-1", parentBotId: "parent", parentRunId, parentChannelId: "channel-1", description: "Check", prompt, subagentType, currentRunId: "child-run-1", outputPath: "/tmp/r.jsonl" },
    "completed",
    result
  );
  expect(calls).toHaveLength(1);
  return calls[0];
}

test("background subagent completion revives the parent with Bot's dedicated source", async () => {
  const block = 'Background task "Check that the release checklist passes on main." (executor) finished:\nRelease checks passed.';
  const wake = await revive("user", "Check that the release checklist passes on main.", "executor", "Release checks passed.");
  expect(wake).toMatchObject({ botId: "parent", channelId: "channel-1", origin: "background_revival", type: "subagent.completed", priority: 260, revival: { block, subagentType: "executor" } });
  // Like any turn, the revival is timestamped and wrapped in <user_query> as a hidden wake.
  expect(wake).not.toHaveProperty("wrapUserContent");
  expect(wake.content).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] ");
  expect(wake.content).toContain(block);
});

test("a task a routine started reports back to the routine as quiet work nobody is waiting on", async () => {
  const wake = await revive("routine", "Check the price of the blue kettle", "computerUse", "Status: done\nStill $49.");
  expect(wake.origin).toBe("routine");
  expect(wake.revival.block).toBe(
    'Background task "Check the price of the blue kettle" (computerUse) finished:\nStatus: done\nStill $49.\n(You started this during your routine "Price watch" (folder price-watch), and nobody is waiting on it.)'
  );
  expect(wake.content).toBe(
    [
      "[SAND_HIDDEN_PROMPT][A background task just completed] A background task you started has finished.",
      "",
      'Background task "Check the price of the blue kettle" (computerUse) finished:',
      "Status: done\nStill $49.",
      '(You started this during your routine "Price watch" (folder price-watch), and nobody is waiting on it.)',
      "",
      "Pick the work back up. Everything above came out of your own quiet routine(s). The user did not ask to hear about it, so the saved instruction's delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendToUser. If it amounts to no change, nothing new, or still waiting, end the turn with no SendToUser at all and no \"still waiting\" or progress notes; if the routine says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you're idle. Never message the user just to say that nothing has changed.",
    ].join("\n")
  );
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
