import { expect, test } from "bun:test";
import { WakeWorker } from "../src/worker";

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
      prompt: "Check that the release checklist passes on main and report any failing step.",
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
  });
  expect((calls[0] as { content: string }).content).toContain(
    'Background task "Check that the release checklist passes on main and report any failing step." (executor) finished:\nRelease checks passed.'
  );
});

test("a task a routine started reports back to the routine as quiet work nobody is waiting on", async () => {
  const calls: Array<{ origin: string; content: string }> = [];
  const worker = Object.create(WakeWorker.prototype) as { notifySubagentParent: (...args: unknown[]) => Promise<void> };
  Object.assign(worker, { messaging: { enqueueWake: async (_tx: unknown, input: { origin: string; content: string }) => { calls.push(input); return {}; } } });
  await worker.notifySubagentParent(
    {
      run: {
        findFirst: async () => ({ id: "routine-run-1", origin: "routine", inboxEvents: [{ payload: {} }] }),
        findUnique: async () => ({ inboxEvents: [] }),
      },
      automationResult: { findUnique: async () => null },
      routineExecution: { findUnique: async ({ where }: any) => (where.runId === "routine-run-1" ? { routine: { name: "Price watch", slug: "price-watch" } } : null) },
      channel: { findUnique: async () => ({ kind: "direct", name: "Parent" }) },
      bot: { findUnique: async () => ({ id: "parent", status: "active" }) },
    } as never,
    { id: "subagent-1", parentBotId: "parent", parentRunId: "routine-run-1", parentChannelId: "channel-1", description: "Check price",
      prompt: "Check the price of the blue kettle", subagentType: "computerUse", currentRunId: "child-run-1", outputPath: "/tmp/r.jsonl" },
    "completed",
    "Status: done\nStill $49."
  );
  expect(calls[0]!.origin).toBe("routine");
  expect(calls[0]!.content).toBe(
    [
      "[A background task just completed] A background task you started has finished.",
      "",
      'Background task "Check the price of the blue kettle" (computerUse) finished:',
      "Status: done\nStill $49.",
      '(You started this during your routine "Price watch" (folder price-watch), and nobody is waiting on it.)',
      "",
      "Pick the work back up. Everything above came out of your own quiet routine(s). The user did not ask to hear about it, so the saved instruction's delivery rule governs. If the outcome is a genuine change, a new actionable result, or a real blocker the user must know about, tell them once with a single useful SendToUser. If it amounts to no change, nothing new, or still waiting, end the turn with no SendToUser at all and no \"still waiting\" or progress notes; if the routine says to keep watching, just keep the watch going quietly. Keep your status current, and clear it once everything is done and you're idle. Never message the user just to say that nothing has changed.",
    ].join("\n")
  );
});
