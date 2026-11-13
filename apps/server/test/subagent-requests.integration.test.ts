// Durable request and subagent-task state end to end: Stop, resume, milestones, parked
// continuations, parent waits and startup recovery, against a real database.
import { expect } from "bun:test";
import { Effect } from "effect";
import {
  AgentMessaging, dispatchRequestChecks, dispatchTaskContinuations, ensureRequestForTask, initialTaskProgress, lockAgentLifecycle,
  recoverRequestProgress, reportRequestProgress, reportTaskProgress, requestProgressSnapshot, requestWakeAllowed,
  settleRequestProgress, settleTaskProgress, stopRequestProgress, type ToolContext,
} from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { recover } from "../src/services/startup-recovery";
import { SubagentService } from "../src/services/subagent/service";
import { dbIt, type Harness, type SeededBot } from "./harness";

const cancelInDb = (h: Harness) => (runId: string) => Effect.promise(async () => {
  const run = await h.db.run.findUniqueOrThrow({ where: { id: runId } });
  if (["queued", "running"].includes(run.status)) await h.db.run.update({ where: { id: runId }, data: { status: "cancelled", completedAt: new Date(), error: { code: "cancelled_by_user" } } });
  return { ok: true, status: "cancelled" };
});
const subagents = (h: Harness, cancel: (runId: string) => Effect.Effect<unknown, unknown> = cancelInDb(h), computer = async (_path: string) => Response.json({ stopped: true })) =>
  new SubagentService(h.db, h.messaging, { cancel } as never, h.dir, computer, h.store);
const owner = async (h: Harness) => {
  await h.store.writeInferenceSettings({ providerId: "openai-codex", modelId: "fixture-model", reasoning: "low" });
  return h.bot("Owner");
};
const completionWake = (h: Harness, bot: SeededBot, taskContextRunId: string) => h.db.$transaction(tx => h.messaging.enqueueWake(tx, {
  botId: bot.id, channelId: bot.channelId!, origin: "background_revival", type: "subagent.completed",
  content: "[SAND_HIDDEN_PROMPT]The requested result is ready.", taskContextRunId, clientId: crypto.randomUUID(), priority: 260,
}));
const settleTask = (h: Harness, subId: string, attemptId: string, runId: string, report?: string) => h.db.$transaction(async tx =>
  settleTaskProgress(tx, h.messaging, await tx.subagent.findUniqueOrThrow({ where: { id: subId } }), attemptId, runId, report));

// ---- Stop fences delivery ----

const sendToUser = (h: Harness, bot: SeededBot, runId: string, channel?: string, connected = { sends: 0 }) => Effect.runPromise(new InternalToolService(h.db, h.messaging, {} as never, async () => {}, {} as never,
  {} as never, {} as never, { deliverConnectedChannel: async () => { connected.sends++; return { connectionId: "fixture", toolName: "send" }; } } as never).execute({
  runId, botId: bot.id, conversationId: bot.conversationId, channelId: bot.channelId!, deliveryId: null, tool: "SendToUser",
  arguments: { type: "text", content: "The result is ready.", ...(channel ? { channel } : {}) }, callId: crypto.randomUUID(),
}));
const runningCompletion = async (h: Harness, bot: SeededBot) => {
  const root = await h.run(bot, { status: "completed" });
  await h.db.$transaction(tx => ensureRequestForTask(tx, bot.id, root.id));
  const wake = await completionWake(h, bot, root.id);
  return { root, run: await h.db.run.update({ where: { id: wake.run.id }, data: { status: "running" } }) };
};

dbIt("a running completion cannot deliver to the chat or a connected channel after Stop", async h => {
  const bot = await h.bot();
  const { root, run } = await runningCompletion(h, bot);
  await h.db.run.update({ where: { id: root.id }, data: { requestStoppedAt: new Date() } });
  const connected = { sends: 0 };
  await expect(sendToUser(h, bot, run.id)).rejects.toThrow("request was stopped");
  await expect(sendToUser(h, bot, run.id, "slack:C123", connected)).rejects.toThrow("request was stopped");
  expect(connected.sends).toBe(0);
  expect(await h.db.channelMessage.count({ where: { channelId: bot.channelId!, sender: "agent" } })).toBe(0);
  expect(await h.db.channelNotification.count({ where: { channelId: bot.channelId! } })).toBe(0);
});

for (const retiring of [false, true]) dbIt(`publication waits for a concurrent ${retiring ? "retirement and Stop" : "Stop"} transaction and reads its committed stop marker`, async h => {
  const bot = await h.bot();
  const { root, run } = await runningCompletion(h, bot);
  const prepared = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>();
  const stopWritten = Promise.withResolvers<void>(), commit = Promise.withResolvers<void>();
  const original = (h.messaging as any).persistedVisibleInput.bind(h.messaging);
  (h.messaging as any).persistedVisibleInput = async (...args: unknown[]) => { prepared.resolve(); await preparation.promise; return original(...args); };
  const pending = sendToUser(h, bot, run.id);
  await prepared.promise;
  const stop = h.db.$transaction(async tx => {
    // Retirement locks lifecycle before the request claim; publication must use the same order.
    if (retiring) await lockAgentLifecycle(tx, bot.id);
    await stopRequestProgress(tx, bot.id, root.id);
    stopWritten.resolve(); await commit.promise;
  });
  try {
    await stopWritten.promise;
    preparation.resolve();
    const lockKey = `${retiring ? "agent-lifecycle" : "bot-run-claim"}:${bot.id}`;
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = await h.db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
        AND objid = hashtext(${lockKey})::oid AND NOT granted) AS waiting`;
      waiting = !!rows[0]?.waiting;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally { preparation.resolve(); commit.resolve(); }
  await stop;
  await expect(pending).rejects.toThrow("request was stopped");
  expect(await h.db.channelMessage.count({ where: { channelId: bot.channelId!, sender: "agent" } })).toBe(0);
});

// ---- Stop and resume of subagent tasks ----

const activate = async (h: Harness, id: string): Promise<ToolContext> => {
  const sub = await h.db.subagent.findUniqueOrThrow({ where: { id } });
  const child = await h.db.bot.update({ where: { id: sub.childBotId }, data: { status: "active" }, include: { conversation: true } });
  const run = await h.db.run.update({ where: { id: sub.currentRunId! }, data: { status: "running" } });
  await h.db.subagent.update({ where: { id }, data: { status: "running" } });
  await h.db.subagentAttempt.update({ where: { childRunId: run.id }, data: { status: "running" } });
  return { botId: child.id, runId: run.id, conversationId: child.conversation!.id, channelId: run.channelId!, deliveryId: null, origin: "agent", callId: crypto.randomUUID(), replyToMessageId: null, isFork: false };
};
const launch = async (h: Harness, service: SubagentService, context: ToolContext) => {
  await service.task(context, { description: "Inspect case", subagent_type: "executor", prompt: "Read the case only; do not send or change anything." });
  const sub = await h.db.subagent.findFirstOrThrow({ where: { parentRunId: context.runId } });
  await activate(h, sub.id);
  return sub;
};
const parkChild = async (h: Harness, id: string, context: ToolContext, check: Date) => {
  await reportTaskProgress(h.db, h.messaging, context, {
    key: `wait:${context.runId}`, state: "waiting", summary: "The case is still processing.", evidence: ["case:fixture"],
    remaining: ["Read the completed case"], nextAction: "Read the case status only.", checkAt: check.toISOString(),
  });
  await h.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  const attempt = await h.db.subagentAttempt.findUniqueOrThrow({ where: { childRunId: context.runId } });
  await settleTask(h, id, attempt.id, context.runId);
};

for (const scope of ["target", "bot"] as const) dbIt(`${scope} Stop of a parked task ends its shells and allows a fresh user resume and durable continuation`, async h => {
  const bot = await owner(h);
  const shellStops: string[] = [];
  const service = subagents(h, undefined, async path => { shellStops.push(path); return Response.json({ stopped: true }); });
  const original = await h.turn(bot, "Inspect the case without sending anything.");
  const child = await launch(h, service, original);
  await parkChild(h, child.id, await activate(h, child.id), new Date(Date.now() + 10_000));
  if (scope === "bot") await Effect.runPromise(service.stopBot(bot.id));
  else await service.stop(bot.id, crypto.randomUUID(), { subagent_id: `sand-subagent-${child.id}` });
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect(shellStops).toContain(`/v1/bots/${child.childBotId}/background-shells/stop`);
  const fresh = await h.turn(bot, "Resume reading the case status only. Do not send or change anything.");
  await service.task(fresh, { resume: `sand-subagent-${child.id}`, description: "Read stopped case", prompt: "Read the case status only; no outgoing action is approved.", read_only: true });
  const resumed = await h.db.subagent.findUniqueOrThrow({ where: { id: child.id } });
  const expectedRoot = scope === "target" ? original.runId : fresh.runId;
  expect(resumed).toMatchObject({ parentRunId: fresh.runId, requestRunId: expectedRoot, stoppedAt: null, readOnly: true });
  if (scope !== "target") expect((await h.db.run.findUniqueOrThrow({ where: { id: original.runId } })).requestStoppedAt).not.toBeNull();
  expect((resumed.scopeUpdates as any[]).some(update => update.source === "host_stop")).toBe(true);
  const check = new Date(Date.now() + 1000);
  await parkChild(h, child.id, await activate(h, child.id), check);
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(check.getTime() + 1))).toBe(1);
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("queued");
  const completing = await activate(h, child.id);
  await reportTaskProgress(h.db, h.messaging, completing, { key: `done:${completing.runId}`, state: "complete", summary: "Read-only case status verified.", evidence: ["case:fixture:verified"], remaining: [] });
  const attempt = await h.db.subagentAttempt.findUniqueOrThrow({ where: { childRunId: completing.runId } });
  expect(await settleTask(h, child.id, attempt.id, completing.runId)).toBe(false);
  // The worker records a terminal turn and enqueues this completion handoff.
  await h.db.run.update({ where: { id: completing.runId }, data: { status: "completed" } });
  await h.db.subagent.update({ where: { id: child.id }, data: { status: "completed" } });
  await h.db.subagentAttempt.update({ where: { id: attempt.id }, data: { status: "completed" } });
  const wake = await completionWake(h, bot, expectedRoot);
  const event = await h.db.inboxEvent.findFirstOrThrow({ where: { runId: wake.run.id } });
  expect(await h.db.$transaction(tx => requestWakeAllowed(tx, event))).toBe(true);
  await h.db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
  await h.messaging.sendVisible({ ...fresh, origin: "background_revival", runId: wake.run.id }, { type: "text", content: "The case status was verified." });
  expect(await h.db.channelMessage.count({ where: { channelId: bot.channelId!, sender: "agent" } })).toBe(1);
});

dbIt("an explicit stopped request ID is refused without permanently fencing a fresh authorized resume", async h => {
  const bot = await owner(h), service = subagents(h);
  const original = await h.turn(bot), child = await launch(h, service, original);
  await Effect.runPromise(service.stopBot(bot.id));
  const fresh = await h.turn(bot, "Resume reading the case status only.");
  const input = { resume: `sand-subagent-${child.id}`, description: "Read stopped case", prompt: "Read the case status only; do not send or change anything.", read_only: true };
  await expect(service.task(fresh, { ...input, request_run_id: original.runId })).rejects.toThrow("This request was stopped");
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  await service.task(fresh, input);
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).requestRunId).toBe(fresh.runId);
  expect((await h.db.run.findUniqueOrThrow({ where: { id: original.runId } })).requestStoppedAt).not.toBeNull();
});

for (const finishedDuringCancel of [false, true]) dbIt(`Stop ${finishedDuringCancel ? "accepts a turn that finished during a failed cancellation" : "reports failure when the active turn cannot be cancelled"}`, async h => {
  const bot = await owner(h), context = await h.turn(bot);
  const service = subagents(h, () => Effect.promise(async () => {
    if (finishedDuringCancel) await h.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
    throw new Error("Synthetic computer cancellation failure");
  }));
  if (finishedDuringCancel) return expect(await Effect.runPromise(service.stopBot(bot.id))).toEqual({ hadActiveRun: true });
  await expect(Effect.runPromise(service.stopBot(bot.id))).rejects.toThrow("could not be stopped");
  expect((await h.db.run.findUniqueOrThrow({ where: { id: context.runId } })).status).toBe("running");
});

dbIt("retrying a failed Stop reaches older stopped requests without stopping a fresh request", async h => {
  const bot = await owner(h), context = await h.turn(bot), tasks = subagents(h);
  await tasks.task(context, { description: "Original work", subagent_type: "executor", prompt: "Compute the original digest." });
  const original = await h.db.subagent.findFirstOrThrow({ where: { parentBotId: bot.id } });
  await h.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  const followup = (await h.turn(bot, "What is the status?")).runId;
  let failOriginal = true;
  const service = subagents(h, (id: string) => Effect.tryPromise(async () => {
    if (id === original.currentRunId && failOriginal) throw new Error("Synthetic cancellation failure");
    await h.db.run.update({ where: { id }, data: { status: "cancelled", completedAt: new Date(), error: { code: "cancelled_by_user" } } });
    return { ok: true, status: "cancelled" };
  }));
  await expect(Effect.runPromise(service.stopRun(followup))).rejects.toThrow("could not be stopped");
  const freshRun = (await h.turn(bot, "Start the independent new digest.")).runId;
  await tasks.task({ ...context, runId: freshRun, callId: crypto.randomUUID() }, { description: "Fresh work", subagent_type: "executor", prompt: "Compute only the new digest." });
  const fresh = await h.db.subagent.findFirstOrThrow({ where: { parentRunId: freshRun } });
  failOriginal = false;
  await Effect.runPromise(service.stopRun(followup));
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: original.id } })).status).toBe("stopped");
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(fresh.status);
  expect((await h.db.run.findUniqueOrThrow({ where: { id: freshRun } })).status).toBe("running");
});

dbIt("a typed follow-up does not discard a completed background result; an explicit stop still does", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await subagents(h).task(context, { description: "Compute digest", subagent_type: "executor", prompt: "Compute the requested digest." });
  await h.db.run.update({ where: { id: context.runId }, data: { status: "cancelled", error: { code: "priority_peer_interrupt", message: "superseded by a new user message" } } });
  const wake = await completionWake(h, bot, context.runId);
  const event = await h.db.inboxEvent.findFirstOrThrow({ where: { runId: wake.run.id } });
  const allowed = () => h.db.$transaction(tx => requestWakeAllowed(tx, event));
  expect(await allowed()).toBe(true);
  await h.db.run.update({ where: { id: context.runId }, data: { error: { code: "user_stopped" } } });
  expect(await allowed()).toBe(false);
  await h.db.run.update({ where: { id: context.runId }, data: { error: { code: "priority_peer_interrupt" } } });
  await h.db.$transaction(tx => stopRequestProgress(tx, bot.id, context.runId));
  expect(await allowed()).toBe(false);
});

// ---- Subagent milestones and parked continuations ----

/** A parent and a running computer-use worker with one attempt. */
async function delegated(h: Harness) {
  const parent = await h.bot("Owner"), child = await h.bot("Worker");
  const parentRun = await h.run(parent), childRun = await h.run(child);
  const sub = await h.db.subagent.create({ data: {
    parentBotId: parent.id, childBotId: child.id, parentRunId: parentRun.id, parentChannelId: parent.channelId!, currentRunId: childRun.id,
    launchCallId: crypto.randomUUID(), description: "Finish a delegated workflow", subagentType: "computerUse", status: "running", outputPath: "/workspace/result",
    prompt: "Complete the approved workflow. Do not add fees or send outside the approved destination.",
  } });
  const attempt = await h.db.subagentAttempt.create({ data: {
    subagentId: sub.id, parentRunId: parentRun.id, parentChannelId: parent.channelId!, parentToolCallId: sub.launchCallId,
    childRunId: childRun.id, description: sub.description, prompt: sub.prompt, status: "running",
  } });
  const context = h.context(child, { runId: childRun.id });
  const progress = {
    key: "verified-stage", state: "working" as const, summary: "The requested stage is verified", evidence: ["https://example.test/case/receipt"],
    remaining: ["Answer the outstanding document request"], nextAction: "Inspect the case and provide the authorized document",
  };
  const check = new Date(Date.now() + 1000);
  const parkWaiting = async () => {
    await reportTaskProgress(h.db, h.messaging, context, { ...progress, state: "waiting", checkAt: check.toISOString() });
    await h.db.run.update({ where: { id: childRun.id }, data: { status: "completed" } });
    await settleTask(h, sub.id, attempt.id, childRun.id);
  };
  return { parent, child, parentRun, childRun, sub, attempt, context, progress, check, parkWaiting };
}

dbIt("concurrent duplicate milestones save and wake once without finishing or resuming the worker", async h => {
  const f = await delegated(h);
  const reports = await Promise.all(Array.from({ length: 4 }, () => reportTaskProgress(h.db, h.messaging, { ...f.context, callId: crypto.randomUUID() }, f.progress)));
  for (const report of reports) expect(report).toEqual(reports[0]!);
  expect(await h.db.inboxEvent.count({ where: { botId: f.parent.id, type: "subagent.progress" } })).toBe(1);
  expect(await h.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({ status: "running", currentRunId: f.childRun.id, progressRevision: 1 });
  await expect(reportTaskProgress(h.db, h.messaging, f.context, { ...f.progress, summary: "A different result" })).rejects.toThrow("milestone key");
  await expect(reportTaskProgress(h.db, h.messaging, { ...f.context, botId: f.parent.id }, f.progress)).rejects.toThrow("current, active");
  await reportTaskProgress(h.db, h.messaging, f.context, { ...f.progress, key: "later-stage", summary: "A later stage is verified" });
  expect(await reportTaskProgress(h.db, h.messaging, f.context, f.progress)).toMatchObject({ revision: 2, deferred: false, progress: { summary: "A later stage is verified" } });
});

dbIt("an initial partial report keeps ownership without copying private report text into progress", async h => {
  const f = await delegated(h);
  const report = "Status: partial\nAn outside decision remains pending. Private fixture context: not-for-progress-storage.";
  await h.db.subagent.update({ where: { id: f.sub.id }, data: { progress: initialTaskProgress(f.childRun.id) as any } });
  expect(await settleTask(h, f.sub.id, f.attempt.id, f.childRun.id, report)).toBe(true);
  const saved = await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
  expect(saved).toMatchObject({ status: "waiting", nextCheckAt: null, result: report, progress: { state: "blocked", blockSource: "runtime" } });
  expect(JSON.stringify(saved.progress)).not.toContain("not-for-progress-storage");
  expect((await h.db.subagentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).result).toBe(report);
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(Date.now() + 3600_000))).toBe(0);
});

dbIt("a stopped original request fences a parked worker even when its immediate parent turn completed", async h => {
  const f = await delegated(h);
  await f.parkWaiting();
  // The request belongs to the same parent bot; its immediate completion wake is a separate turn.
  const request = await h.run(f.parent, { status: "completed", requestStoppedAt: new Date() });
  await h.db.subagent.update({ where: { id: f.sub.id }, data: { requestRunId: request.id } });
  await h.db.run.update({ where: { id: f.parentRun.id }, data: { status: "completed" } });
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(f.check.getTime() + 1))).toBe(0);
  expect(await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).toMatchObject({ status: "stopped", nextCheckAt: null });
  expect(await h.db.inboxEvent.count({ where: { botId: f.child.id, type: "subagent.continue" } })).toBe(0);
});

dbIt("new parent instructions replace a parked continuation before its old timer can fire", async h => {
  const f = await delegated(h);
  await f.parkWaiting();
  const result = await subagents(h).task(h.context(f.parent, { runId: f.parentRun.id }), {
    resume: f.sub.id, description: "Apply updated scope", prompt: "New user instruction: inspect only. Do not send the document or incur fees.",
  });
  expect(String(result)).toContain("Subagent is running");
  const current = await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
  expect(current.nextCheckAt).toBeNull();
  expect(JSON.stringify(current.scopeUpdates)).toContain("inspect only");
  expect(current.prompt).toContain("Do not add fees");
  expect(current.currentRunId).not.toBe(f.childRun.id);
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(f.check.getTime() + 1))).toBe(0);
});

dbIt("a user stop wins when an automatic continuation races the cancellation acknowledgement", async h => {
  const f = await delegated(h);
  await f.parkWaiting();
  let raced = false;
  const service = subagents(h, (id: string) => Effect.tryPromise(async () => {
    await h.db.run.updateMany({ where: { id, status: { in: ["queued", "running"] } }, data: { status: "cancelled" } });
    await h.db.inboxEvent.updateMany({ where: { runId: id, status: "pending" }, data: { status: "completed" } });
  }), async () => {
    if (!raced) { raced = true; expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(f.check.getTime() + 1))).toBe(1); }
    return Response.json({ stopped: true });
  });
  expect(await service.stop(f.parent.id, "cancel-race", { subagent_id: f.sub.id })).toMatchObject({ stopped: true });
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe("stopped");
  expect(await h.db.run.count({ where: { botId: f.child.id, status: { in: ["queued", "running"] } } })).toBe(0);
});

// ---- Parent request waits ----

const wait = (key = "confirmation-pending") => ({
  key, state: "waiting" as const, summary: "An authorized message was sent once; confirmation remains pending.", evidence: ["/appointments/receipt"],
  remaining: ["Verify the appointment confirmation"], nextAction: "Read the confirmation status. Ask before any further outgoing message.",
  checkAt: new Date(Date.now() + 3600_000).toISOString(), deadline: new Date(Date.now() + 7200_000).toISOString(),
});
const pendingChecks = (h: Harness, botId: string) => h.db.inboxEvent.findMany({ where: { botId, type: "request.check", status: "pending" } });

dbIt("a saved parent wait survives a fresh dispatcher and concurrent duplicate checks enqueue once", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  const input = wait();
  const [a, b] = await Promise.all([reportRequestProgress(h.db, context, input), reportRequestProgress(h.db, context, input)]);
  expect(a).toEqual(b);
  const fresh = new AgentMessaging(h.db, h.messaging.boss, h.store);
  const future = new Date(Date.now() + 3601_000);
  const results = await Promise.all([dispatchRequestChecks(h.db, fresh, future), dispatchRequestChecks(h.db, fresh, future)]);
  expect(results[0]! + results[1]!).toBe(1);
  const checks = await pendingChecks(h, bot.id);
  expect(checks).toHaveLength(1);
  expect(await h.db.$transaction(tx => requestWakeAllowed(tx, checks[0]!))).toBe(true);
  expect(await h.db.subagent.count({ where: { parentBotId: bot.id } })).toBe(0); // no automatic outgoing action
});

dbIt("user cancellation wins against due dispatch and cannot be undone by a late milestone", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await reportRequestProgress(h.db, context, wait());
  await Promise.all([dispatchRequestChecks(h.db, h.messaging, new Date(Date.now() + 3601_000)), h.db.$transaction(tx => stopRequestProgress(tx, bot.id))]);
  expect(await dispatchRequestChecks(h.db, h.messaging, new Date(Date.now() + 86400_000))).toBe(0);
  expect(await pendingChecks(h, bot.id)).toHaveLength(0);
  await expect(reportRequestProgress(h.db, context, wait("late"))).rejects.toThrow("stopped");
  expect(await requestProgressSnapshot(h.db, bot.id, bot.channelId!)).toEqual([]);
});

dbIt("an unresolved turn gets at most three private reconciliation reminders, then a durable blocker", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await h.db.$transaction(tx => ensureRequestForTask(tx, bot.id, context.runId));
  for (let i = 0; i < 5; i++) {
    await h.db.$transaction(tx => settleRequestProgress(tx, h.messaging, bot.id, context.runId));
    await h.db.inboxEvent.updateMany({ where: { botId: bot.id, type: "request.check", status: "pending" }, data: { status: "completed" } });
  }
  expect(await h.db.inboxEvent.count({ where: { botId: bot.id, type: "request.check" } })).toBe(3);
  expect(await h.db.run.findUniqueOrThrow({ where: { id: context.runId } })).toMatchObject({
    requestReconciliations: 3, requestProgress: { state: "blocked", blockSource: "runtime" }, requestNextCheckAt: null,
  });
});

dbIt("recovery catches a crash between model completion and parent bookkeeping without duplicating the check", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await h.db.$transaction(tx => ensureRequestForTask(tx, bot.id, context.runId));
  await h.db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
  await recoverRequestProgress(h.db, h.messaging);
  await recoverRequestProgress(h.db, h.messaging);
  expect(await pendingChecks(h, bot.id)).toHaveLength(1);
});

dbIt("verified completion clears its wait, rejects changed-key replay and stays complete across later turns", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await reportRequestProgress(h.db, context, wait());
  const complete = { key: "verified-and-delivered", state: "complete" as const, summary: "Confirmation independently verified and delivered to the user", evidence: ["/appointments/confirmation", "message:delivered"], remaining: [] };
  await reportRequestProgress(h.db, context, complete);
  expect(await requestProgressSnapshot(h.db, bot.id, bot.channelId!)).toEqual([]);
  expect(await dispatchRequestChecks(h.db, h.messaging, new Date(Date.now() + 86400_000))).toBe(0);
  await h.db.$transaction(tx => settleRequestProgress(tx, h.messaging, bot.id, context.runId));
  await expect(reportRequestProgress(h.db, context, { ...complete, summary: "different" })).rejects.toThrow("different progress");
  await expect(h.db.$transaction(tx => ensureRequestForTask(tx, bot.id, context.runId))).rejects.toThrow("completed request");
});

dbIt("an arbitrary request ID cannot cross agents or conversations", async h => {
  const bot = await owner(h), context = await h.turn(bot);
  await expect(reportRequestProgress(h.db, context, { ...wait(), request_run_id: crypto.randomUUID() })).rejects.toThrow("belong");
  const room = await h.channel({ name: "Different conversation", kind: "group", members: { create: { botId: bot.id, ordinal: 0 } } });
  const other = await h.turn(bot, "Separate conversation", { channelId: room.id });
  await expect(reportRequestProgress(h.db, context, { ...wait(), request_run_id: other.runId })).rejects.toThrow("conversation");
});

// ---- Startup recovery of in-flight delegated work ----

/** A user request whose delegated worker was mid-turn when the server stopped. */
async function interrupted(h: Harness) {
  const make = async (name: string) => {
    const bot = await h.bot(name);
    const { runId } = await h.turn(bot, "Inspect the private export; no new fees or publication.");
    await h.db.run.update({ where: { id: runId }, data: { inputDeliveredAt: new Date() } });
    await h.db.inboxEvent.updateMany({ where: { runId }, data: { status: "processing", claimedAt: new Date() } });
    await h.db.botRunLease.create({ data: { botId: bot.id, runId, scope: "foreground", ownerId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 120000) } });
    return { bot, runId };
  };
  const parent = await make("Owner"), child = await make("Worker");
  // Only the parent is a user-origin request. The child owns a delegated task.
  await h.db.run.update({ where: { id: child.runId }, data: { origin: "agent" } });
  const sub = await h.db.subagent.create({ data: {
    parentBotId: parent.bot.id, childBotId: child.bot.id, parentRunId: parent.runId, parentChannelId: parent.bot.channelId!, currentRunId: child.runId,
    launchCallId: crypto.randomUUID(), description: "Private export", prompt: "Generate once, verify the receipt, keep private and accept no fees.",
    subagentType: "executor", status: "running", outputPath: "/workspace/report", progress: initialTaskProgress(child.runId),
  } });
  await h.db.subagentAttempt.create({ data: {
    subagentId: sub.id, parentRunId: parent.runId, parentChannelId: parent.bot.channelId!, parentToolCallId: sub.launchCallId,
    childRunId: child.runId, description: sub.description, prompt: sub.prompt, status: "running",
  } });
  return { parent, child, sub };
}

dbIt("startup preserves uncheckpointed obligations and schedules one reconciliation", async h => {
  const f = await interrupted(h);
  const cancellations: string[] = [];
  const computer = async (path: string) => { cancellations.push(path); return Response.json({ ok: true }); };
  await recover(h.db, h.messaging.boss, h.messaging, computer);
  expect(cancellations).toContain(`/v1/turns/${f.child.runId}/cancel`);
  expect(await h.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
    status: "waiting", recoveryAttempts: 1, progress: { reconciliationRequired: true, remaining: initialTaskProgress(f.child.runId).remaining },
  });
  expect((await h.db.run.findUniqueOrThrow({ where: { id: f.child.runId } })).status).toBe("interrupted");
  expect(await h.db.botRunLease.count({ where: { runId: f.child.runId } })).toBe(0);
  await recover(h.db, h.messaging.boss, h.messaging, computer);
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).recoveryAttempts).toBe(1);
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(Date.now() + 2000))).toBe(1);
  expect(await dispatchTaskContinuations(h.db, h.messaging, new Date(Date.now() + 2000))).toBe(0);
  const wake = await h.db.inboxEvent.findFirstOrThrow({ where: { botId: f.child.bot.id, type: "subagent.continue" } });
  expect(JSON.stringify(wake.payload)).toContain("before repeating");
  const reconcile = await h.db.inboxEvent.findMany({ where: { botId: f.parent.bot.id, type: "runtime.reconcile" } });
  expect(reconcile).toHaveLength(1);
  // The resumed turn tells the person it was a restart, not a failed connection.
  expect(JSON.stringify(reconcile[0]!.payload)).toContain("OpenTeam restarted");
  // A saved continuation owns the interrupted request; asking to resend would risk duplicates.
  expect(await h.db.channelMessage.count({ where: { clientId: `restart-interrupted:${f.parent.runId}` } })).toBe(0);
});

dbIt("a failed context stop rolls recovery back without queuing duplicate work", async h => {
  const f = await interrupted(h);
  await expect(recover(h.db, h.messaging.boss, h.messaging, async () => new Response("unavailable", { status: 503 }))).rejects.toThrow("Could not reconcile");
  expect((await h.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe("running");
  expect(await h.db.inboxEvent.count({ where: { type: "subagent.continue", botId: f.child.bot.id } })).toBe(0);
  expect((await h.db.run.findUniqueOrThrow({ where: { id: f.child.runId } })).status).toBe("running");
});

dbIt("a restart posts one chat notice per cut-off user turn and wakes no bot", async h => {
  const bot = await h.bot("Restart notice");
  const wakes: unknown[] = [], jobs: unknown[][] = [];
  const messaging = { enqueueWake: async (...args: unknown[]) => void wakes.push(args), enqueueBootstrap: async () => undefined, recoverRounds: async () => undefined };
  const cutOff = await h.run(bot), routine = await h.run(bot, { origin: "routine" }), finished = await h.run(bot, { status: "completed" });
  for (let restart = 0; restart < 2; restart++) await recover(h.db, { send: async (...args: unknown[]) => void jobs.push(args) } as never, messaging as never, async () => new Response());
  const notices = await h.db.channelMessage.findMany({ where: { channelId: bot.channelId! } });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    sender: "system", clientId: `restart-interrupted:${cutOff.id}`, content: "This reply was interrupted by a restart. Send your message again to continue.",
    metadata: { type: "event", event: { type: "turn-interrupted", reason: "restart", runId: cutOff.id } },
  });
  expect(wakes).toHaveLength(0);
  expect(jobs.filter(job => job[0] === "bot-wake")).toHaveLength(0);
  const statuses = await h.db.run.findMany({ where: { botId: bot.id }, select: { id: true, status: true } });
  expect(Object.fromEntries(statuses.map(row => [row.id, row.status]))).toEqual({ [cutOff.id]: "interrupted", [routine.id]: "interrupted", [finished.id]: "completed" });
});
