// The worker's periodic memory review recovery scan on PostgreSQL: fairness across bots,
// per-bot ordering, the concurrency cap, and runs that change before their review is claimed.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
type Bot = { id: string; conversationId: string };
type RecoveryWorker = {
  recoverMemoryReviews(): Promise<void>;
  reviewMemoryRun(runId: string): Promise<void>;
  recordMemoryFromRun(runId: string): Promise<void>;
  memoryReviews: Map<string, Promise<void>>;
};

/** The real recovery scan, reviewer, durable ordering and lease code; queue consumers are not started. */
function fixture(work: (fixture: {
  db: ReturnType<typeof createPrismaClient>;
  worker: RecoveryWorker;
  addBot(): Promise<Bot>;
  addRun(bot: Bot, marker: number, options?: { id?: string; completedInbox?: boolean; second?: number }): Promise<string>;
  /** Leases `bot`'s review to another live owner. */
  lease(bot: Bot): Promise<string>;
  calls: string[];
  setInference(infer: (marker: string) => Promise<void>): void;
  beforeClaim(hook: () => Promise<void>): void;
}) => Promise<void>) {
  return async () => {
    const db = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-recovery-"));
    const revision = (await db.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
    const botIds: string[] = [], calls: string[] = [];
    let infer = async (_marker: string) => {};
    let claimHook: (() => Promise<void>) | undefined;
    const store = new AgentDataStore(db, { root, workspaceRoot: root, memoryInference: async request => {
      const marker = [...request.prompt.matchAll(/RECOVERY-\d+/g)].at(-1)?.[0] ?? "unmarked";
      calls.push(marker);
      await infer(marker);
      return `profile: The user's calibration marker is ${marker}.`;
    } });
    const worker = Object.create(WakeWorker.prototype) as RecoveryWorker;
    Object.defineProperties(worker, {
      prisma: { value: db }, agentData: { value: store },
      // The reviewer reads the user's time zone after its run snapshot, just before claiming.
      messaging: { value: { userTimeZone: async () => {
        const hook = claimHook;
        if (hook) { claimHook = undefined; await hook(); }
        return "UTC";
      } } },
      stopping: { value: false, writable: true }, memoryReviewScanActive: { value: false, writable: true },
      memoryReviewCursor: { value: null, writable: true }, memoryReviews: { value: new Map<string, Promise<void>>() },
    });
    try {
      await work({ db, worker, calls, setInference: handler => { infer = handler; }, beforeClaim: hook => { claimHook = hook; },
        addBot: async () => {
          const bot = await db.bot.create({ data: { name: "Memory recovery", status: "active", defaultDirectory: root, conversation: { create: {} } },
            include: { conversation: true } });
          botIds.push(bot.id);
          return { id: bot.id, conversationId: bot.conversation!.id };
        },
        addRun: async (bot, marker, { id, completedInbox = true, second = marker } = {}) => {
          const at = new Date(Date.UTC(2026, 10, 13, 12, 0, second));
          const run = await db.run.create({ data: { id, botId: bot.id, conversationId: bot.conversationId, userMessageId: crypto.randomUUID(),
            origin: "user", status: "completed", completedAt: at, memoryReviewPending: true, memoryReviewRevision: revision } });
          await db.message.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: run.id, role: "user", status: "completed",
            content: `Remember my calibration marker RECOVERY-${marker}.`, createdAt: at } });
          if (completedInbox) await db.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: run.id,
            idempotencyKey: `memory-recovery:${crypto.randomUUID()}`, type: "message.created", payload: {}, status: "completed", completedAt: at } });
          return run.id;
        },
        lease: async bot => {
          const ownerId = crypto.randomUUID();
          await db.$executeRaw`INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
            VALUES (${bot.id}::uuid, ${ownerId}::uuid, clock_timestamp() + INTERVAL '10 minutes')`;
          return ownerId;
        },
      });
    } finally {
      await Promise.allSettled([...worker.memoryReviews.values()]);
      await db.memoryFact.deleteMany({ where: { writtenByBotId: { in: botIds } } });
      await db.event.deleteMany({ where: { entityId: { in: botIds } } });
      await db.bot.deleteMany({ where: { id: { in: botIds } } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function scanAndSettle(worker: RecoveryWorker) {
  await worker.recoverMemoryReviews();
  await Promise.all([...worker.memoryReviews.values()]);
  expect(worker.memoryReviews.size).toBe(0);
}
async function until(check: () => boolean) {
  for (const deadline = Date.now() + 30_000; !check();) {
    if (Date.now() >= deadline) throw new Error("Memory recovery fixture did not reach its barrier");
    await Bun.sleep(5);
  }
}

databaseTest("leased backlogs, even one bot's 33 older reviews or more than 32 leased bots, cannot starve a healthy bot", fixture(async ({ db, worker, addBot, addRun, lease, calls }) => {
  const blocked = await addBot();
  for (let index = 0; index < 33; index++) await addRun(blocked, index);
  const leased = [{ bot: blocked, ownerId: await lease(blocked) }];
  for (let index = 0; index < 33; index++) {
    const bot = await addBot();
    await addRun(bot, 100 + index, { second: 0 });
    leased.push({ bot, ownerId: await lease(bot) });
  }
  const healthy = await addBot();
  const healthyRun = await addRun(healthy, 999);
  for (let scan = 0; scan < 3; scan++) await scanAndSettle(worker);
  expect(await db.run.count({ where: { botId: { in: leased.map(entry => entry.bot.id) }, memoryReviewPending: true } })).toBe(66);
  for (const { bot, ownerId } of leased) expect((await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: bot.id } })).ownerId).toBe(ownerId);
  expect({ pending: (await db.run.findUniqueOrThrow({ where: { id: healthyRun } })).memoryReviewPending, calls }).toEqual({ pending: false, calls: ["RECOVERY-999"] });
}), 120_000);

databaseTest("a bot's reviews run in completion order, ties broken by run id, and never two at once", fixture(async ({ db, worker, addBot, addRun, setInference, calls }) => {
  const bot = await addBot();
  const suffix = crypto.randomUUID().slice(9);
  const ids = [1, 2, 3].map(index => `${index.toString(16).padStart(8, "0")}-${suffix}`);
  for (const marker of [3, 2, 1]) await addRun(bot, marker, { id: ids[marker - 1], second: 0 });
  // While the oldest review is still inferring, recovery must not launch the bot's next one.
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  setInference(async () => { entered.resolve(); await release.promise; });
  const launched: string[] = [];
  const record = worker.recordMemoryFromRun.bind(worker);
  Object.defineProperty(worker, "recordMemoryFromRun", { value: async (runId: string) => { launched.push(runId); return record(runId); } });
  const running = worker.reviewMemoryRun(ids[0]!);
  try {
    await entered.promise;
    for (let scan = 0; scan < 2; scan++) {
      await worker.recoverMemoryReviews();
      await Promise.all([...worker.memoryReviews].filter(([id]) => id !== ids[0]).map(([, review]) => review));
    }
    expect(launched.filter(id => ids.includes(id))).toEqual([ids[0]!]);
  } finally {
    release.resolve();
    await running;
  }
  setInference(async () => {});
  for (let scan = 0; scan < 2; scan++) await scanAndSettle(worker);
  expect(calls).toEqual(["RECOVERY-1", "RECOVERY-2", "RECOVERY-3"]);
  expect(await db.run.count({ where: { id: { in: ids }, memoryReviewPending: false } })).toBe(3);
}), 60_000);

databaseTest("an oldest pending review without a completed inbox does not gate the bot's later eligible review", fixture(async ({ db, worker, addBot, addRun, calls }) => {
  const bot = await addBot();
  const ineligible = await addRun(bot, 0, { completedInbox: false });
  const eligible = await addRun(bot, 1);
  for (let scan = 0; scan < 2; scan++) await scanAndSettle(worker);
  expect({ pending: (await db.run.findUniqueOrThrow({ where: { id: eligible } })).memoryReviewPending, calls }).toEqual({ pending: false, calls: ["RECOVERY-1"] });
  expect(await db.memoryFact.count({ where: { writtenByBotId: bot.id, turnId: ineligible } })).toBe(0);
}), 60_000);

databaseTest("recovery keeps at most 32 reviews active and uses capacity as it is released", fixture(async ({ db, worker, addBot, addRun, setInference, calls }) => {
  // 31 reviews already in flight leave room for exactly one more.
  const inFlight = Array.from({ length: 31 }, () => crypto.randomUUID());
  for (const id of inFlight) worker.memoryReviews.set(id, new Promise<void>(() => {}));
  const runIds = [await addRun(await addBot(), 1), await addRun(await addBot(), 2)];
  const release = Promise.withResolvers<void>();
  setInference(() => release.promise);
  try {
    await worker.recoverMemoryReviews();
    await until(() => calls.length === 1);
    expect(worker.memoryReviews.size).toBe(32);
    await worker.recoverMemoryReviews();
    await Bun.sleep(100);
    expect({ calls: calls.length, tracked: worker.memoryReviews.size }).toEqual({ calls: 1, tracked: 32 });
    worker.memoryReviews.delete(inFlight.pop()!);
    await worker.recoverMemoryReviews();
    await until(() => calls.length === 2);
    expect(worker.memoryReviews.size).toBe(32);
  } finally {
    release.resolve();
    for (const id of inFlight) worker.memoryReviews.delete(id);
    await Promise.allSettled([...worker.memoryReviews.values()]);
  }
  expect(await db.run.count({ where: { id: { in: runIds }, memoryReviewPending: false } })).toBe(2);
}), 60_000);

databaseTest("a dispatched review cannot learn once its run is cancelled, loses its completed inbox, or is deleted before the claim", async () => {
  const outcomes: Array<{ fault: string; calls: number; facts: number }> = [];
  for (const fault of ["cancelled", "inbox-ineligible", "deleted"] as const) await fixture(async ({ db, worker, addBot, addRun, beforeClaim, calls }) => {
    const bot = await addBot();
    const runId = await addRun(bot, 1);
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    beforeClaim(async () => { reached.resolve(); await release.promise; });
    try {
      await worker.recoverMemoryReviews();
      await reached.promise;
      if (fault === "cancelled") await db.run.update({ where: { id: runId }, data: { status: "cancelled" } });
      else if (fault === "inbox-ineligible") await db.inboxEvent.updateMany({ where: { runId }, data: { status: "pending" } });
      else await db.run.delete({ where: { id: runId } });
    } finally { release.resolve(); await Promise.all([...worker.memoryReviews.values()]); }
    outcomes.push({ fault, calls: calls.length, facts: await db.memoryFact.count({ where: { writtenByBotId: bot.id } }) });
  })();
  expect(outcomes).toEqual(["cancelled", "inbox-ineligible", "deleted"].map(fault => ({ fault, calls: 0, facts: 0 })));
}, 60_000);
