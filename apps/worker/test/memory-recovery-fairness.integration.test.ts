import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
const healthyFact = "The user's favorite tea is oolong.";

type RecoveryWorker = {
  recoverMemoryReviews(): Promise<void>;
  reviewMemoryRun(runId: string): Promise<void>;
  recordMemoryFromRun(runId: string): Promise<void>;
  memoryReviews: Map<string, Promise<void>>;
};

async function fixture(work: (fixture: {
  db: ReturnType<typeof createPrismaClient>;
  worker: RecoveryWorker;
  addBot(name: string): Promise<{ id: string; conversationId: string }>;
  addRun(bot: { id: string; conversationId: string }, ordinal: number, completedInbox?: boolean): Promise<string>;
  inferenceCalls: string[];
  setInference(infer: (prompt: string) => Promise<string>): void;
}) => Promise<void>) {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-recovery-fairness-"));
  const sharedRevision = (await db.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
  const botIds: string[] = [];
  const inferenceCalls: string[] = [];
  let infer = async (_prompt: string) => `profile: ${healthyFact}`;
  const store = new AgentDataStore(db, { root, workspaceRoot: root, memoryInference: async request => {
    inferenceCalls.push(request.prompt);
    return infer(request.prompt);
  } });
  // Exercise the real recovery, reviewer, durable ordering and lease methods.
  // Queue consumers/network services are irrelevant to these periodic scans.
  const worker = Object.create(WakeWorker.prototype) as RecoveryWorker;
  Object.defineProperties(worker, {
    prisma: { value: db },
    agentData: { value: store },
    messaging: { value: { userTimeZone: async () => "UTC" } },
    stopping: { value: false, writable: true },
    memoryReviewScanActive: { value: false, writable: true },
    memoryReviewCursor: { value: null, writable: true },
    memoryReviews: { value: new Map<string, Promise<void>>() },
  });
  try {
    await work({ db, worker, inferenceCalls, setInference: handler => { infer = handler; },
      addBot: async name => {
        const bot = await db.bot.create({ data: { name, status: "active", defaultDirectory: root, conversation: { create: {} } },
          include: { conversation: true } });
        botIds.push(bot.id);
        return { id: bot.id, conversationId: bot.conversation!.id };
      },
      addRun: async (bot, ordinal, completedInbox = true) => {
        const at = new Date(Date.UTC(2026, 10, 13, 12, 0, ordinal));
        const run = await db.run.create({ data: {
          botId: bot.id, conversationId: bot.conversationId, userMessageId: crypto.randomUUID(),
          origin: "user", status: "completed", completedAt: at, memoryReviewPending: true, memoryReviewRevision: sharedRevision,
        } });
        await db.message.create({ data: {
          botId: bot.id, conversationId: bot.conversationId, runId: run.id,
          role: "user", status: "completed", content: "Remember that my favorite tea is oolong.", createdAt: at,
        } });
        if (completedInbox) await db.inboxEvent.create({ data: {
          botId: bot.id, conversationId: bot.conversationId, runId: run.id,
          idempotencyKey: `memory-fairness:${crypto.randomUUID()}`, type: "message.created", payload: {},
          status: "completed", completedAt: at,
        } });
        return run.id;
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
}

async function scanAndSettle(worker: RecoveryWorker) {
  await worker.recoverMemoryReviews();
  await Promise.all([...worker.memoryReviews.values()]);
  expect(worker.memoryReviews.size).toBe(0);
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Memory reviewer fixture did not reach its expected barrier");
    await Bun.sleep(2);
  }
}

databaseTest("a leased bot's 33 older pending reviews cannot starve another healthy bot across recovery scans", () => fixture(async ({ db, worker, addBot, addRun, inferenceCalls }) => {
  const blocked = await addBot("Blocked memory backlog");
  const healthy = await addBot("Healthy memory backlog");
  for (let index = 0; index < 33; index++) await addRun(blocked, index);
  const healthyRun = await addRun(healthy, 100);
  const ownerId = crypto.randomUUID();
  await db.$executeRaw`INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
    VALUES (${blocked.id}::uuid, ${ownerId}::uuid, clock_timestamp() + INTERVAL '60 seconds')`;
  for (let scan = 0; scan < 4; scan++) {
    await scanAndSettle(worker);
    expect(await db.run.count({ where: { botId: blocked.id, memoryReviewPending: true } })).toBe(33);
    expect((await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: blocked.id } })).ownerId).toBe(ownerId);
  }
  const pending = (await db.run.findUniqueOrThrow({ where: { id: healthyRun } })).memoryReviewPending;
  const facts = await db.memoryFact.findMany({ where: { writtenByBotId: healthy.id, supersededAt: null }, select: { fact: true } });
  expect({ pending, facts, inferenceCalls: inferenceCalls.length }).toEqual({ pending: false, facts: [{ fact: healthyFact }], inferenceCalls: 1 });
}), 15_000);

databaseTest("recovery rotates past more than 32 leased bots to reach a later healthy bot", () => fixture(async ({ db, worker, addBot, addRun, inferenceCalls }) => {
  const blocked: Array<{ id: string; ownerId: string; runId: string }> = [];
  for (let index = 0; index < 35; index++) {
    const bot = await addBot(`Leased memory bot ${index}`);
    const runId = await addRun(bot, index);
    const ownerId = crypto.randomUUID();
    await db.$executeRaw`INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
      VALUES (${bot.id}::uuid, ${ownerId}::uuid, clock_timestamp() + INTERVAL '60 seconds')`;
    blocked.push({ id: bot.id, ownerId, runId });
  }
  const healthy = await addBot("Later healthy memory bot");
  const healthyRun = await addRun(healthy, 100);
  for (let scan = 0; scan < 4; scan++) {
    await scanAndSettle(worker);
    expect(await db.run.count({ where: { id: { in: blocked.map(bot => bot.runId) }, memoryReviewPending: true } })).toBe(35);
    const leases = await db.memoryReviewLease.findMany({ where: { botId: { in: blocked.map(bot => bot.id) } }, select: { botId: true, ownerId: true } });
    expect(leases).toHaveLength(35);
    for (const lease of leases) expect(lease.ownerId).toBe(blocked.find(bot => bot.id === lease.botId)!.ownerId);
  }
  const pending = (await db.run.findUniqueOrThrow({ where: { id: healthyRun } })).memoryReviewPending;
  const facts = await db.memoryFact.findMany({ where: { writtenByBotId: healthy.id, supersededAt: null }, select: { fact: true } });
  expect({ pending, facts, inferenceCalls: inferenceCalls.length }).toEqual({ pending: false, facts: [{ fact: healthyFact }], inferenceCalls: 1 });
}), 15_000);

databaseTest("an in-flight local oldest review prevents launching the bot's later review during recovery", () => fixture(async ({ db, worker, addBot, addRun, setInference, inferenceCalls }) => {
  const bot = await addBot("Locally running oldest memory review");
  const oldest = await addRun(bot, 0);
  const later = await addRun(bot, 1);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  setInference(async () => {
    entered.resolve();
    await release.promise;
    return `profile: ${healthyFact}`;
  });
  const launched: string[] = [];
  const record = worker.recordMemoryFromRun.bind(worker);
  Object.defineProperty(worker, "recordMemoryFromRun", { value: async (runId: string) => {
    launched.push(runId);
    return record(runId);
  } });
  const running = worker.reviewMemoryRun(oldest);
  try {
    await entered.promise;
    const lease = await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: bot.id } });
    for (let scan = 0; scan < 4; scan++) {
      await worker.recoverMemoryReviews();
      // Settle any mistakenly launched later review without waiting on the
      // deliberately blocked real oldest reviewer.
      await Promise.all([...worker.memoryReviews].filter(([id]) => id !== oldest).map(([, review]) => review));
      expect(worker.memoryReviews.has(oldest)).toBe(true);
      expect((await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: bot.id } })).ownerId).toBe(lease.ownerId);
      expect((await db.run.findUniqueOrThrow({ where: { id: later } })).memoryReviewPending).toBe(true);
    }
    expect({ launched, inferenceCalls: inferenceCalls.length }).toEqual({ launched: [oldest], inferenceCalls: 1 });
  } finally {
    release.resolve();
    await running;
  }
  // Once the oldest actually finishes, the next durable review can progress.
  await scanAndSettle(worker);
  expect((await db.run.findUniqueOrThrow({ where: { id: later } })).memoryReviewPending).toBe(false);
}), 15_000);

databaseTest("an oldest pending review without a completed inbox cannot permanently gate the bot's later eligible review", () => fixture(async ({ db, worker, addBot, addRun, inferenceCalls }) => {
  const bot = await addBot("Incomplete oldest memory review");
  const ineligibleRun = await addRun(bot, 0, false);
  const eligibleRun = await addRun(bot, 1);
  for (let scan = 0; scan < 4; scan++) await scanAndSettle(worker);
  const eligiblePending = (await db.run.findUniqueOrThrow({ where: { id: eligibleRun } })).memoryReviewPending;
  const facts = await db.memoryFact.findMany({ where: { writtenByBotId: bot.id, supersededAt: null }, select: { fact: true } });
  expect({ eligiblePending, facts, inferenceCalls: inferenceCalls.length }).toEqual({ eligiblePending: false, facts: [{ fact: healthyFact }], inferenceCalls: 1 });
  // Invalid historical bookkeeping must not be treated as a reviewed exchange.
  expect(await db.memoryFact.count({ where: { writtenByBotId: bot.id, turnId: ineligibleRun } })).toBe(0);
}), 15_000);

databaseTest("background recovery keeps at most 32 slow reviews active across scans and uses released capacity", () => fixture(async ({ db, worker, addBot, addRun, setInference, inferenceCalls }) => {
  const runIds: string[] = [];
  for (let index = 0; index < 33; index++) {
    const bot = await addBot(`Slow inference memory bot ${index}`);
    runIds.push(await addRun(bot, index));
  }
  const releases: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  let releaseAll = false;
  let active = 0;
  let maxActive = 0;
  setInference(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    const release = Promise.withResolvers<void>();
    releases.push(release);
    try {
      if (!releaseAll) await release.promise;
      return `profile: ${healthyFact}`;
    } finally { active--; }
  });
  try {
    await worker.recoverMemoryReviews();
    await until(() => releases.length === 32);
    expect({ active, tracked: worker.memoryReviews.size }).toEqual({ active: 32, tracked: 32 });
    await worker.recoverMemoryReviews();
    // Let every selected review reach the real inference callback before
    // measuring; this detects provider concurrency, not merely queued promises.
    const selectedAfterSecondScan = worker.memoryReviews.size;
    await until(() => releases.length === selectedAfterSecondScan);
    expect({ inferenceCalls: inferenceCalls.length, active, maxActive, tracked: worker.memoryReviews.size })
      .toEqual({ inferenceCalls: 32, active: 32, maxActive: 32, tracked: 32 });
    expect(await db.run.count({ where: { id: { in: runIds }, memoryReviewPending: true } })).toBe(33);

    releases[0]!.resolve();
    await until(() => worker.memoryReviews.size === 31);
    await worker.recoverMemoryReviews();
    await until(() => releases.length === 33);
    expect({ inferenceCalls: inferenceCalls.length, active, maxActive, tracked: worker.memoryReviews.size })
      .toEqual({ inferenceCalls: 33, active: 32, maxActive: 32, tracked: 32 });
  } finally {
    releaseAll = true;
    for (const release of releases) release.resolve();
    await Promise.allSettled([...worker.memoryReviews.values()]);
  }
  expect(await db.run.count({ where: { id: { in: runIds }, memoryReviewPending: false } })).toBe(33);
  expect(worker.memoryReviews.size).toBe(0);
}), 15_000);
