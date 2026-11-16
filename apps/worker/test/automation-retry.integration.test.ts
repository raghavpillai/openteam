import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineService, wakeAutomationParent } from "@openteam/messaging";
import { AUTOMATION_RETRY_DELAYS_MS, WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

type Claimed = { runId: string; inboxId: string };
type Internals = {
  boss: { send: (...args: unknown[]) => Promise<unknown> };
  claim(botId: string): Promise<Claimed | null>;
  fail(claimed: Claimed, error: unknown, interrupted?: boolean): Promise<void>;
  projection: { apply(runId: string, conversationId: string, botId: string, event: { type: "turn.completed"; turnId: string; status: "completed" }): Promise<unknown> };
  syncRoutineRunFile(botId: string, runId: string): Promise<void>;
};

const outage = () => new Error('500: {"message":"upstream exploded","type":"server_error"}');

const harness = async (name: string) => {
  const root = await mkdtemp(join(tmpdir(), "automation-retry-"));
  const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
  const worker = new WakeWorker();
  const internals = worker as unknown as Internals;
  const sent: unknown[][] = [];
  internals.boss.send = async (...args: unknown[]) => { sent.push(args); return "job"; };
  (worker.messaging as unknown as { boss: unknown }).boss = { send: async () => "job", sendDebounced: async () => "job" };
  const db = worker.prisma;
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const bot = await db.bot.create({ data: { id: botId, name, defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
  await db.channel.create({ data: { id: channelId, kind: "bot_dm", name, directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
  const routines = new RoutineService(db, worker.messaging);
  const routine = await routines.mutate(botId, crypto.randomUUID(), null, { action: "create", name: "Morning brief", prompt: "Send the morning brief.", schedule: "@every 1h" }) as { id: string };
  await db.routine.update({ where: { id: routine.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
  expect(await routines.dispatchDue()).toBe(1);
  return {
    worker, internals, db, botId, channelId, conversationId: bot.conversation!.id, routineId: routine.id, sent,
    // Make the requeued wake claimable now instead of after its backoff.
    due: () => db.inboxEvent.updateMany({ where: { botId, status: "pending" }, data: { availableAt: new Date(Date.now() - 1000) } }),
    cleanup: async () => {
      await db.bot.deleteMany({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await worker.stop();
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await rm(root, { recursive: true, force: true });
    },
  };
};

test.skipIf(!databaseUrl)("chaos: a routine run that fails before acting is retried with backoff, then fails for good", async () => {
  const h = await harness("Outage retry");
  try {
    const first = await h.internals.claim(h.botId);
    expect(first).not.toBeNull();
    for (const [index, delay] of AUTOMATION_RETRY_DELAYS_MS.entries()) {
      const claimed = index === 0 ? first! : await h.internals.claim(h.botId);
      // The same run and wake come back, so the routine's execution stays the one that fired.
      expect(claimed?.runId).toBe(first!.runId);
      // Every turn starts by recording its prompt fingerprint, before the model is called.
      await h.db.runItem.create({ data: { runId: claimed!.runId, upstreamItemId: `prompt:${claimed!.runId}:${crypto.randomUUID()}`, kind: "tool", status: "completed", title: "promptFingerprint", content: { type: "promptFingerprint" } } });
      // The model provider is down for the whole attempt.
      await h.db.run.update({ where: { id: claimed!.runId }, data: { status: "failed" } });
      const before = Date.now();
      await h.internals.fail(claimed!, outage());
      const wake = await h.db.inboxEvent.findUniqueOrThrow({ where: { id: claimed!.inboxId } });
      expect(wake.status).toBe("pending");
      expect(wake.availableAt.getTime()).toBeGreaterThanOrEqual(before + delay - 1000);
      expect((await h.db.run.findUniqueOrThrow({ where: { id: claimed!.runId } })).status).toBe("queued");
      expect(h.sent.at(-1)).toEqual(["bot-wake", { botId: h.botId }, expect.objectContaining({ startAfter: delay / 1000 })]);
      // The routine is not reported failed while a retry is pending.
      expect((await h.db.routineExecution.findFirstOrThrow({ where: { routineId: h.routineId } })).status).toBe("running");
      await h.due();
    }
    const last = await h.internals.claim(h.botId);
    await h.db.run.update({ where: { id: last!.runId }, data: { status: "failed" } });
    await h.internals.fail(last!, outage());
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: last!.inboxId } })).status).toBe("failed");
    expect((await h.db.routineExecution.findFirstOrThrow({ where: { routineId: h.routineId } })).status).toBe("failed");
  } finally {
    await h.cleanup();
  }
}, 30000);

test.skipIf(!databaseUrl)("chaos: a routine run that already ran a tool is not retried", async () => {
  const h = await harness("Acted once");
  try {
    const claimed = await h.internals.claim(h.botId);
    await h.db.runItem.create({ data: { runId: claimed!.runId, kind: "tool", status: "completed", content: { name: "UpdateMemory" } } });
    await h.db.run.update({ where: { id: claimed!.runId }, data: { status: "failed" } });
    await h.internals.fail(claimed!, outage());
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: claimed!.inboxId } })).status).toBe("failed");
    expect((await h.db.routineExecution.findFirstOrThrow({ where: { routineId: h.routineId } })).status).toBe("failed");
    expect(h.sent.filter(([queue]) => queue === "bot-wake")).toEqual([]);
  } finally {
    await h.cleanup();
  }
}, 30000);

test.skipIf(!databaseUrl)("chaos: a routine paused after it fired is not retried", async () => {
  const h = await harness("Paused");
  try {
    const claimed = await h.internals.claim(h.botId);
    await h.db.routine.update({ where: { id: h.routineId }, data: { enabled: false, pausedAt: new Date() } });
    await h.db.run.update({ where: { id: claimed!.runId }, data: { status: "failed" } });
    await h.internals.fail(claimed!, outage());
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: claimed!.inboxId } })).status).toBe("failed");
  } finally {
    await h.cleanup();
  }
}, 30000);

test.skipIf(!databaseUrl)("chaos: a routine's handoff to the parent survives a failed parent turn", async () => {
  const h = await harness("Handoff retry");
  try {
    const routineRun = await h.internals.claim(h.botId);
    // The routine finished and handed its result to the parent.
    const handoff = await wakeAutomationParent(h.worker.messaging, {
      botId: h.botId, conversationId: h.conversationId, channelId: h.channelId, runId: routineRun!.runId,
      callId: crypto.randomUUID(), origin: "routine", isFork: false, deliveryId: null, replyToMessageId: null,
    }, { message: "The brief is ready: rain at 9am." });
    await h.db.run.update({ where: { id: routineRun!.runId }, data: { status: "completed", completedAt: new Date() } });
    await h.db.inboxEvent.update({ where: { id: routineRun!.inboxId }, data: { status: "completed", completedAt: new Date() } });
    await h.db.botRunLease.deleteMany({ where: { botId: h.botId } });
    const parentTurn = await h.internals.claim(h.botId);
    expect(parentTurn?.runId).toBe(handoff.run_id);
    // The parent's turn hits the provider outage before it can message the user.
    await h.db.run.update({ where: { id: parentTurn!.runId }, data: { status: "failed" } });
    await h.internals.fail(parentTurn!, outage());
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: parentTurn!.inboxId } })).status).toBe("pending");
    await h.due();
    // The same handoff is offered again, so the user still gets the result.
    expect((await h.internals.claim(h.botId))?.runId).toBe(handoff.run_id);
  } finally {
    await h.cleanup();
  }
}, 30000);

for (const settled of [false, true]) {
  test.skipIf(!databaseUrl)(`a former routine wake owner cannot fail a ${settled ? "completed" : "live"} reclaimed attempt`, async () => {
    const h = await harness("Reclaimed owner fence");
    try {
      const former = (await h.internals.claim(h.botId))!;
      await h.db.inboxEvent.update({ where: { id: former.inboxId }, data: { claimedAt: new Date(Date.now() - 180_000) } });
      await h.db.botRunLease.updateMany({ where: { runId: former.runId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      const successor = await h.internals.claim(h.botId);
      expect(successor?.runId).toBe(former.runId);
      const successorLease = await h.db.botRunLease.findFirstOrThrow({ where: { runId: former.runId } });
      if (settled) {
        await h.db.run.update({ where: { id: former.runId }, data: { status: "completed", completedAt: new Date() } });
        await h.db.inboxEvent.update({ where: { id: former.inboxId }, data: { status: "completed", completedAt: new Date() } });
        await h.db.botRunLease.deleteMany({ where: { runId: former.runId } });
      }
      await h.internals.fail(former, outage());
      expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: former.inboxId } })).status).toBe(settled ? "completed" : "processing");
      expect((await h.db.run.findUniqueOrThrow({ where: { id: former.runId } })).status).toBe(settled ? "completed" : "running");
      if (!settled) expect((await h.db.botRunLease.findFirstOrThrow({ where: { runId: former.runId } })).ownerId).toBe(successorLease.ownerId);
      expect(h.sent.filter(([queue]) => queue === "bot-wake")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  }, 30_000);
}

test.skipIf(!databaseUrl)("projected completion settles its inbox after a current-owner failure", async () => {
  const h = await harness("Projected completion recovery");
  try {
    const claimed = (await h.internals.claim(h.botId))!;
    await h.internals.projection.apply(claimed.runId, h.conversationId, h.botId,
      { type: "turn.completed", turnId: claimed.runId, status: "completed" });
    await h.internals.fail(claimed, new Error("settlement failed after completion projection"));
    expect((await h.db.run.findUniqueOrThrow({ where: { id: claimed.runId } })).status).toBe("completed");
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: claimed.inboxId } })).status).toBe("completed");
    expect(await h.db.botRunLease.count({ where: { runId: claimed.runId } })).toBe(0);
    expect((await h.db.routineExecution.findFirstOrThrow({ where: { runId: claimed.runId } })).status).toBe("completed");
    expect(await h.db.event.count({ where: { topic: "run.interrupted", entityId: claimed.runId } })).toBe(0);
  } finally {
    await h.cleanup();
  }
}, 30_000);

test.skipIf(!databaseUrl)("completed settlement retries its file reconciliation without reopening the run", async () => {
  const h = await harness("Completed file recovery");
  try {
    const claimed = (await h.internals.claim(h.botId))!;
    await h.internals.projection.apply(claimed.runId, h.conversationId, h.botId,
      { type: "turn.completed", turnId: claimed.runId, status: "completed" });
    await h.db.inboxEvent.update({ where: { id: claimed.inboxId }, data: { status: "completed", completedAt: new Date() } });
    await h.db.botRunLease.deleteMany({ where: { runId: claimed.runId } });
    let synced = 0;
    h.internals.syncRoutineRunFile = async () => { synced++; };
    await h.internals.fail(claimed, new Error("routine file sync failed after settlement"));
    expect(synced).toBe(1);
    const run = await h.db.run.findUniqueOrThrow({ where: { id: claimed.runId } });
    expect(run.status).toBe("completed");
    expect(run.memoryReviewPending).toBe(false);
    expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: claimed.inboxId } })).status).toBe("completed");
    expect(await h.db.event.count({ where: { topic: "inbox.completed", entityId: claimed.inboxId } })).toBe(0);
  } finally {
    await h.cleanup();
  }
}, 30_000);
