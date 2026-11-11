import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import {
  AgentDataStore, AgentMessaging, dispatchTaskContinuations, reportTaskProgress,
  settleTaskProgress, requestWakeAllowed, type ToolContext,
} from "@openteam/messaging";
import { SubagentService } from "../src/services/subagent/service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await body(f); }
  finally {
    const children = await f.db.subagent.findMany({ where: { parentBotId: f.bot.id } });
    const botIds = [f.bot.id, ...children.map(c => c.childBotId)];
    const channels = await f.db.channelMember.findMany({ where: { botId: { in: botIds } } });
    await f.db.idempotencyRecord.deleteMany({ where: { scope: { in: [
      `subagent-task:${f.bot.id}`, ...children.map(c => `task-progress:${c.id}`),
    ] } } });
    await f.db.bot.deleteMany({ where: { id: { in: botIds } } });
    await f.db.channel.deleteMany({ where: { id: { in: channels.map(c => c.channelId) } } });
    await f.db.$disconnect();
    await rm(f.dir, { recursive: true, force: true });
  }
}

async function setup() {
  const db = createPrismaClient(url!);
  const dir = await mkdtemp(join(tmpdir(), "stop-resume-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  await store.writeRootSettings({});
  await store.writeInferenceSettings({ providerId: "openai-codex", modelId: "fixture-model", reasoning: "low" });
  const messaging = new AgentMessaging(db, {
    send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID(),
  } as never, store);
  const bot = await db.bot.create({ data: {
    name: "Stop resume owner", status: "active", onboardingStatus: "completed", defaultDirectory: dir,
    conversation: { create: {} },
  }, include: { conversation: true } });
  const channel = await db.channel.create({ data: {
    kind: "bot_dm", name: "main", directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } },
  } });
  const cancelled: string[] = [];
  const cancelFailures = new Set<string>();
  const service = new SubagentService(db, messaging, {
    cancel: (runId: string) => Effect.promise(async () => {
      cancelled.push(runId);
      if (cancelFailures.has(runId)) throw new Error("Synthetic cancellation transport failure");
      const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
      if (["queued", "running"].includes(run.status)) await db.run.update({ where: { id: runId }, data: {
        status: "cancelled", completedAt: new Date(), error: { code: "cancelled_by_user" },
      } });
      return { ok: true, status: "cancelled" };
    }),
  } as never, dir, async () => Response.json({ stopped: true }), store);
  const parent = async (text = "Inspect the case without sending anything.") => {
    const wake = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: bot.id, channelId: channel.id, origin: "user", type: "user.message", content: text,
      clientId: crypto.randomUUID(), priority: 300,
    }));
    await db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
    return { botId: bot.id, runId: wake.run.id, conversationId: bot.conversation!.id,
      channelId: channel.id, deliveryId: null, origin: "user", callId: crypto.randomUUID(),
    } as ToolContext;
  };
  const activate = async (id: string) => {
    const sub = await db.subagent.findUniqueOrThrow({ where: { id } });
    const child = await db.bot.update({ where: { id: sub.childBotId }, data: { status: "active" }, include: { conversation: true } });
    const run = await db.run.update({ where: { id: sub.currentRunId! }, data: { status: "running" } });
    await db.subagent.update({ where: { id }, data: { status: "running" } });
    await db.subagentAttempt.update({ where: { childRunId: run.id }, data: { status: "running" } });
    return { botId: child.id, runId: run.id, conversationId: child.conversation!.id,
      channelId: run.channelId!, deliveryId: null, origin: "agent", callId: crypto.randomUUID(),
    } as ToolContext;
  };
  const launch = async (context: ToolContext) => {
    await service.task(context, { description: "Inspect case", subagent_type: "executor", prompt: "Read the case only; do not send or change anything." });
    const sub = await db.subagent.findFirstOrThrow({ where: { parentRunId: context.runId } });
    await activate(sub.id);
    return sub;
  };
  const park = async (id: string, context: ToolContext, check: Date) => {
    await reportTaskProgress(db, messaging, context, {
      key: `wait:${context.runId}`, state: "waiting", summary: "The case is still processing.",
      evidence: ["case:fixture"], remaining: ["Read the completed case"], nextAction: "Read the case status only.", checkAt: check.toISOString(),
    });
    await db.run.update({ where: { id: context.runId }, data: { status: "completed" } });
    const attempt = await db.subagentAttempt.findUniqueOrThrow({ where: { childRunId: context.runId } });
    await db.$transaction(async tx => settleTaskProgress(tx, messaging,
      await tx.subagent.findUniqueOrThrow({ where: { id } }), attempt.id, context.runId));
  };
  return { db, dir, bot, channel, messaging, service, parent, launch, activate, park, cancelled, cancelFailures };
}

for (const scope of ["target", "all", "bot"] as const) for (const parked of [false, true])
test.skipIf(!url)(`${scope} Stop of a ${parked ? "parked" : "running"} task allows a fresh user resume and durable continuation`, () => fixture(async f => {
  const original = await f.parent();
  const child = await f.launch(original);
  if (parked) await f.park(child.id, await f.activate(child.id), new Date(Date.now() + 10_000));
  if (scope === "bot") await Effect.runPromise(f.service.stopBot(f.bot.id));
  else await f.service.stop(f.bot.id, crypto.randomUUID(), scope === "all" ? { all: true } : { subagent_id: `sand-subagent-${child.id}` });
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  const fresh = await f.parent("Resume reading the case status only. Do not send or change anything.");
  await f.service.task(fresh, { resume: `sand-subagent-${child.id}`, description: "Read stopped case", prompt: "Read the case status only; no outgoing action is approved.", read_only: true });
  const resumed = await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } });
  const expectedRoot = scope === "target" ? original.runId : fresh.runId;
  expect(resumed).toMatchObject({ parentRunId: fresh.runId, requestRunId: expectedRoot, stoppedAt: null, readOnly: true });
  if (scope !== "target") expect((await f.db.run.findUniqueOrThrow({ where: { id: original.runId } })).requestStoppedAt).not.toBeNull();
  expect((resumed.scopeUpdates as any[]).some(update => update.source === "host_stop")).toBe(true);
  const check = new Date(Date.now() + 1000);
  await f.park(child.id, await f.activate(child.id), check);
  expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))).toBe(1);
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("queued");
  const completing = await f.activate(child.id);
  await reportTaskProgress(f.db, f.messaging, completing, {
    key: `done:${completing.runId}`, state: "complete", summary: "Read-only case status verified.", evidence: ["case:fixture:verified"], remaining: [],
  });
  const attempt = await f.db.subagentAttempt.findUniqueOrThrow({ where: { childRunId: completing.runId } });
  expect(await f.db.$transaction(async tx => settleTaskProgress(tx, f.messaging,
    await tx.subagent.findUniqueOrThrow({ where: { id: child.id } }), attempt.id, completing.runId))).toBe(false);
  // The worker records a terminal turn and enqueues this completion handoff.
  await f.db.run.update({ where: { id: completing.runId }, data: { status: "completed" } });
  await f.db.subagent.update({ where: { id: child.id }, data: { status: "completed" } });
  await f.db.subagentAttempt.update({ where: { id: attempt.id }, data: { status: "completed" } });
  const wake = await f.db.$transaction(tx => f.messaging.enqueueWake(tx, {
    botId: f.bot.id, channelId: f.channel.id, origin: "background_revival", type: "subagent.completed",
    content: "[SAND_HIDDEN_PROMPT]Read-only case inspection completed.", clientId: crypto.randomUUID(), priority: 260, taskContextRunId: expectedRoot,
  }));
  const event = await f.db.inboxEvent.findFirstOrThrow({ where: { runId: wake.run.id } });
  expect(await f.db.$transaction(tx => requestWakeAllowed(tx, event))).toBe(true);
  await f.db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
  await f.messaging.sendVisible({ ...fresh, origin: "background_revival", runId: wake.run.id }, { type: "text", content: "The case status was verified." });
  expect(await f.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(1);
}));

test.skipIf(!url)("an explicit stopped request ID is refused without permanently fencing a fresh authorized resume", () => fixture(async f => {
  const original = await f.parent(), child = await f.launch(original);
  await Effect.runPromise(f.service.stopBot(f.bot.id));
  const fresh = await f.parent("Resume reading the case status only.");
  const input = { resume: `sand-subagent-${child.id}`, description: "Read stopped case", prompt: "Read the case status only; do not send or change anything.", read_only: true };
  await expect(f.service.task(fresh, { ...input, request_run_id: original.runId })).rejects.toThrow("This request was stopped");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  await f.service.task(fresh, input);
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).requestRunId).toBe(fresh.runId);
  expect((await f.db.run.findUniqueOrThrow({ where: { id: original.runId } })).requestStoppedAt).not.toBeNull();
}));

test.skipIf(!url)("targeted StopSubagent leaves an independent sibling request running", () => fixture(async f => {
  const first = await f.parent(), firstChild = await f.launch(first);
  const sibling = await f.parent(), siblingChild = await f.launch(sibling);
  await f.service.stop(f.bot.id, crypto.randomUUID(), { subagent_id: `sand-subagent-${firstChild.id}` });
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: firstChild.id } })).status).toBe("stopped");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: siblingChild.id } })).status).toBe("running");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: sibling.runId } })).requestStoppedAt).toBeNull();
  expect(f.cancelled).not.toContain(siblingChild.currentRunId!);
}));

for (const status of ["completed", "failed", "interrupted", "cancelled"] as const)
test.skipIf(!url)(`stopping a ${status} request stops its active worker and leaves an independent sibling alive`, () => fixture(async f => {
  const first = await f.parent(), firstChild = await f.launch(first);
  await f.db.run.update({ where: { id: first.runId }, data: { status, ...(status === "cancelled" ? { error: { code: "priority_peer_interrupt" } } : {}) } });
  const sibling = await f.parent(), siblingChild = await f.launch(sibling);
  await Effect.runPromise(f.service.stopRun(first.runId));
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: firstChild.id } })).status).toBe("stopped");
  expect(f.cancelled).toContain(firstChild.currentRunId!);
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: siblingChild.id } })).status).toBe("running");
  expect((await f.db.run.findUniqueOrThrow({ where: { id: sibling.runId } })).requestStoppedAt).toBeNull();
}));

test.skipIf(!url)("stopping a completed continuation follows its original request without stopping a sibling", () => fixture(async f => {
  const first = await f.parent(), child = await f.launch(first);
  await f.db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
  const continuation = await f.db.$transaction(tx => f.messaging.enqueueWake(tx, {
    botId: f.bot.id, channelId: f.channel.id, origin: "background_revival", type: "subagent.progress",
    content: "[SAND_HIDDEN_PROMPT]The case is still processing.", clientId: crypto.randomUUID(), priority: 260, taskContextRunId: first.runId,
  }));
  await f.db.run.update({ where: { id: continuation.run.id }, data: { status: "completed" } });
  const sibling = await f.parent(), siblingChild = await f.launch(sibling);
  await Effect.runPromise(f.service.stopRun(continuation.run.id));
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: siblingChild.id } })).status).toBe("running");
  expect(f.cancelled).not.toContain(siblingChild.currentRunId!);
}));

test.skipIf(!url)("Stop of a completed request reports cancellation failure and retries only its old worker", () => fixture(async f => {
  const first = await f.parent(), child = await f.launch(first);
  await f.db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
  f.cancelFailures.add(child.currentRunId!);
  await expect(Effect.runPromise(f.service.stopRun(first.runId))).rejects.toThrow("could not be stopped");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("running");
  const sibling = await f.parent(), siblingChild = await f.launch(sibling);
  f.cancelFailures.clear();
  await Effect.runPromise(f.service.stopRun(first.runId));
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("stopped");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: siblingChild.id } })).status).toBe("running");
  expect(f.cancelled).not.toContain(siblingChild.currentRunId!);
}));

test.skipIf(!url)("Stop of a completed request preserves its finished worker and leaves siblings alive", () => fixture(async f => {
  const first = await f.parent(), child = await f.launch(first);
  await f.db.run.update({ where: { id: first.runId }, data: { status: "completed" } });
  await f.db.run.update({ where: { id: child.currentRunId! }, data: { status: "completed" } });
  await f.db.subagent.update({ where: { id: child.id }, data: { status: "completed" } });
  const sibling = await f.parent(), siblingChild = await f.launch(sibling);
  await Effect.runPromise(f.service.stopRun(first.runId));
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("completed");
  expect((await f.db.subagent.findUniqueOrThrow({ where: { id: siblingChild.id } })).status).toBe("running");
  expect(f.cancelled).not.toContain(child.currentRunId!);
  expect(f.cancelled).not.toContain(siblingChild.currentRunId!);
}));
