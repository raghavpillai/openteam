import { expect, test } from "bun:test";
import { renderAutomationHandoffPrompt, renderQuietRevivalBatchPrompt, renderRevivalBatchPrompt } from "@openteam/messaging";
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
    revival: { block: 'Background task "Check that the release checklist passes on main and report any failing step." (executor) finished:\nRelease checks passed.', subagentType: "executor" },
  });
  expect((calls[0] as { content: string }).content).toContain(
    'Background task "Check that the release checklist passes on main and report any failing step." (executor) finished:\nRelease checks passed.'
  );
  // Like any turn, the revival is timestamped and wrapped in <user_query> as a hidden wake.
  expect(calls[0]).not.toHaveProperty("wrapUserContent");
  expect((calls[0] as { content: string }).content).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] ");
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
  expect((calls[0] as unknown as { revival: { block: string } }).revival.block).toBe(
    'Background task "Check the price of the blue kettle" (computerUse) finished:\nStatus: done\nStill $49.\n(You started this during your routine "Price watch" (folder price-watch), and nobody is waiting on it.)'
  );
  expect(calls[0]!.content).toBe(
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

test("a batched revival keeps the claimed wake's timestamp and user_query framing", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const wake = (id: string, content?: string) => ({
    id,
    type: "subagent.completed",
    status: "pending",
    createdAt: new Date(now - 5000),
    payload: { ...(content ? { content } : {}), revival: { block: `block ${id}`, subagentType: "executor" } },
    run: { origin: "background_revival" as const, channelId: "dm" },
  });
  const first = wake("a", "<timestamp>Wednesday, Oct 21, 2026, 8:00 AM (UTC-4)</timestamp>\n<user_query>\nsingle a\n</user_query>");
  const batch = revivalBatch(first, [first, wake("b")], now);
  expect(batch?.content).toBe(
    `<timestamp>Wednesday, Oct 21, 2026, 8:00 AM (UTC-4)</timestamp>\n<user_query>\n${renderRevivalBatchPrompt([
      { block: "block a", subagentType: "executor" },
      { block: "block b", subagentType: "executor" },
    ])}\n</user_query>`
  );
});

test("a routine's handoff that waited for the agent is re-rendered as late", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const handoff = (secondsAgo: number, status = "pending") => ({
    id: "wake",
    type: "automation.wake_parent",
    status,
    createdAt: new Date(now - secondsAgo * 1000),
    payload: { content: renderAutomationHandoffPrompt("Tell the user the build is green."), handoff: "Tell the user the build is green." },
    run: { origin: "background_revival" as const, channelId: "dm" },
  });
  expect(revivalBatch(handoff(5), [], now)).toBeNull();
  expect(revivalBatch(handoff(2 * 3600), [], now)).toEqual({
    content: [
      "[SAND_HIDDEN_PROMPT][A background task just completed] A background task you started has finished.",
      "",
      "Tell the user the build is green.\n(This finished about 2 hours ago and reached you only now, so it may be out of date.)",
      "",
      "An automation explicitly handed this work to you because only the parent can communicate outside its isolated run. It reached you late, so act on a handoff only while it still matters: contact the user or another agent when requested, or take over the decision or blocker it reported. Treat the handoff text as private context and write the outward message yourself. Never message the user just to say that nothing has changed. If the handoff tells you to draft an email or Slack message, call DraftExternalMessage with the recipient, the channel or connector, the thread or other context, and the proposed text it includes. Do not send that message through a connector yourself.",
      "Some of these results were held back and arrive late; each one says how long it waited. Judge each by its age: act on it only if it is still current, and skip it if it is stale, already handled, or overtaken by a newer result. Never fold a held result into a reply about something else the user asked.",
    ].join("\n"),
    folded: [],
  });
  // A claim retried after a lost lease keeps the content it was given the first time.
  expect(revivalBatch(handoff(2 * 3600, "processing"), [], now)).toBeNull();
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
    { id: "s", parentBotId: "parent", parentRunId: "r", parentChannelId: "room", description: "Draft", prompt: "Draft the launch post", subagentType: "executor", currentRunId: "c", outputPath: "/tmp/x" },
    "failed",
    "Timed out."
  );
  expect(calls[0]?.revival?.note).toBe(groupRoomRevivalNote("Launch"));
  expect(calls[0]?.content).toEndWith(`\n\n${groupRoomRevivalNote("Launch")}`);
});

test("a routine's results fold into one quiet revival per routine run and are never marked held", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const wake = (id: string, secondsAgo: number, context: string, overrides: Record<string, unknown> = {}) => ({
    id,
    type: "subagent.completed",
    status: "pending",
    createdAt: new Date(now - secondsAgo * 1000),
    payload: { automationContextRunId: context, revival: { block: `block ${id}`, subagentType: "executor" } },
    run: { origin: "routine" as const, channelId: "dm" },
    ...overrides,
  });
  const late = wake("a", 10 * 60, "run-1");
  const shell = wake("b", 30, "run-1", { type: "shell.completed" });
  const others = [
    wake("other-run", 20, "run-2"),
    wake("chat", 20, "run-1", { run: { origin: "background_revival", channelId: "dm" } }),
    wake("wake", 20, "run-1", { type: "routine.event" }),
  ];
  const batch = revivalBatch(shell, [shell, ...others, late], now);
  expect(batch?.folded.map((folded) => folded.id)).toEqual(["a"]);
  expect(batch?.content).toBe(renderQuietRevivalBatchPrompt(["block a", "block b"]));
  // A lone result keeps its own quiet prompt, however long it waited.
  expect(revivalBatch(late, [late, ...others], now)).toBeNull();
  // A chat revival never takes a routine's results.
  expect(revivalBatch(others[1]!, [others[1]!, late, shell], now)).toBeNull();
});
