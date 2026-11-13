import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { WakeWorker } from "../src/worker";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
type Bot = { id: string; conversationId: string };
type Candidate = { id: string; botId: string };
type Recovery = {
  recoverMemoryReviews(): Promise<void>;
  memoryReviews: Map<string, Promise<void>>;
};

async function fixture(work: (f: {
  db: ReturnType<typeof createPrismaClient>; worker: Recovery; calls: string[];
  addBot(): Promise<Bot>;
  addRun(bot: Bot, marker: number, id?: string): Promise<string>;
  afterScan(hook: (rows: Candidate[]) => Promise<void>): void;
  beforeClaim(hook: () => Promise<void>): void;
}) => Promise<void>) {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "memory-recovery-churn-"));
  const bots: string[] = [];
  const calls: string[] = [];
  const revision = (await db.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
  let scanHook: ((rows: Candidate[]) => Promise<void>) | undefined;
  let claimHook: (() => Promise<void>) | undefined;
  const scannedDb = new Proxy(db, { get(owner, key) {
    if (key !== "$queryRaw") return Reflect.get(owner, key);
    return async (...args: any[]) => {
      const rows = await (owner.$queryRaw as any)(...args);
      const hook = scanHook;
      if (hook) { scanHook = undefined; await hook(rows); }
      return rows;
    };
  } });
  const store = new AgentDataStore(db, { root, workspaceRoot: root, memoryInference: async request => {
    const marker = [...request.prompt.matchAll(/CHURN-\d+/g)].at(-1)?.[0];
    if (!marker) throw new Error("Missing synthetic churn marker");
    calls.push(marker);
    return `profile: The user's calibration marker is ${marker}.`;
  } });
  const worker = Object.create(WakeWorker.prototype) as Recovery;
  Object.defineProperties(worker, {
    prisma: { value: scannedDb }, agentData: { value: store },
    messaging: { value: { userTimeZone: async () => {
      const hook = claimHook;
      if (hook) { claimHook = undefined; await hook(); }
      return "UTC";
    } } },
    stopping: { value: false, writable: true }, memoryReviewScanActive: { value: false, writable: true },
    memoryReviewCursor: { value: null, writable: true }, memoryReviews: { value: new Map() },
  });
  try {
    await work({ db, worker, calls, afterScan: hook => { scanHook = hook; }, beforeClaim: hook => { claimHook = hook; },
      addBot: async () => {
        const bot = await db.bot.create({ data: { name: "Memory churn fixture", status: "active", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
        bots.push(bot.id);
        return { id: bot.id, conversationId: bot.conversation!.id };
      },
      addRun: async (bot, marker, id) => {
        const at = new Date("2026-11-13T12:00:00Z");
        const run = await db.run.create({ data: { id, botId: bot.id, conversationId: bot.conversationId,
          userMessageId: crypto.randomUUID(), origin: "user", status: "completed", completedAt: at,
          memoryReviewPending: true, memoryReviewRevision: revision } });
        await db.message.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: run.id,
          role: "user", status: "completed", content: `Remember my calibration marker CHURN-${marker}.`, createdAt: at } });
        await db.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: run.id,
          idempotencyKey: `memory-churn:${crypto.randomUUID()}`, type: "message.created", payload: {}, status: "completed", completedAt: at } });
        return run.id;
      },
    });
  } finally {
    await Promise.allSettled([...worker.memoryReviews.values()]);
    await db.memoryFact.deleteMany({ where: { writtenByBotId: { in: bots } } });
    await db.event.deleteMany({ where: { entityId: { in: bots } } });
    await db.bot.deleteMany({ where: { id: { in: bots } } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

async function settle(worker: Recovery) {
  await Promise.all([...worker.memoryReviews.values()]);
  expect(worker.memoryReviews.size).toBe(0);
}

dbTest("equal completion timestamps use UUID order even when runs were inserted in reverse", () => fixture(async ({ db, worker, addBot, addRun, calls }) => {
  const bot = await addBot();
  const suffix = crypto.randomUUID().slice(9);
  const ids = [1, 2, 3].map(index => `${index.toString(16).padStart(8, "0")}-${suffix}`);
  for (const marker of [3, 2, 1]) await addRun(bot, marker, ids[marker - 1]);
  for (let scan = 0; scan < 3; scan++) {
    await worker.recoverMemoryReviews(); await settle(worker);
    expect(calls).toEqual([1, 2, 3].slice(0, scan + 1).map(marker => `CHURN-${marker}`));
  }
  expect(await db.run.count({ where: { id: { in: ids }, memoryReviewPending: false } })).toBe(3);
}), 15_000);

dbTest("a full scan invalidated before dispatch still reaches later owners and wraps across lease-owner churn", () => fixture(async ({ db, worker, addBot, addRun, afterScan, calls }) => {
  const runs: Candidate[] = [];
  for (let index = 0; index < 35; index++) {
    const bot = await addBot();
    runs.push({ id: await addRun(bot, index), botId: bot.id });
  }
  let selected: Candidate[] = [];
  afterScan(async rows => {
    selected = rows;
    expect(selected).toHaveLength(32);
    await Promise.all([
      db.run.deleteMany({ where: { id: { in: selected.slice(0, 10).map(row => row.id) } } }),
      db.run.updateMany({ where: { id: { in: selected.slice(10, 21).map(row => row.id) } }, data: { status: "cancelled" } }),
      db.inboxEvent.updateMany({ where: { runId: { in: selected.slice(21).map(row => row.id) } }, data: { status: "pending" } }),
    ]);
  });
  await worker.recoverMemoryReviews(); await settle(worker);
  expect(calls).toEqual([]);
  const later = runs.filter(run => !selected.some(row => row.id === run.id));
  await worker.recoverMemoryReviews(); await settle(worker);
  expect(await db.run.count({ where: { id: { in: later.map(row => row.id) }, memoryReviewPending: false } })).toBe(3);

  // Restore two lower-UUID owners behind the cursor: one current lease changes
  // owner, while the other expires. The next scan must wrap without stealing.
  const current = selected[10]!, expired = selected[11]!;
  await db.run.updateMany({ where: { id: { in: [current.id, expired.id] } }, data: { status: "completed" } });
  for (const row of [current, expired]) await db.$executeRaw`
    INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
    VALUES (${row.botId}::uuid, ${crypto.randomUUID()}::uuid, clock_timestamp() + INTERVAL '60 seconds')`;
  const nextOwner = crypto.randomUUID();
  await db.$executeRaw`UPDATE "MemoryReviewLease" SET "ownerId" = ${nextOwner}::uuid WHERE "botId" = ${current.botId}::uuid`;
  await db.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${expired.botId}::uuid`;
  for (let scan = 0; scan < 2; scan++) { await worker.recoverMemoryReviews(); await settle(worker); }
  expect((await db.run.findUniqueOrThrow({ where: { id: expired.id } })).memoryReviewPending).toBe(false);
  expect((await db.run.findUniqueOrThrow({ where: { id: current.id } })).memoryReviewPending).toBe(true);
  expect((await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: current.botId } })).ownerId).toBe(nextOwner);
  expect(calls).toHaveLength(4);
}), 15_000);

dbTest("a dispatch snapshot cannot learn after its run is cancelled, loses its completed inbox, or is deleted before claim", async () => {
  const outcomes: Array<{ fault: string; inferenceCalls: number; facts: number }> = [];
  for (const fault of ["cancelled", "inbox-ineligible", "deleted"] as const) await fixture(async ({ db, worker, addBot, addRun, beforeClaim, calls }) => {
    const bot = await addBot();
    const runId = await addRun(bot, 1);
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    // The reviewer has already fetched the completed Run, inbox and exchange.
    // Pause at the final await before the real AgentDataStore lease claim.
    beforeClaim(async () => { reached.resolve(); await release.promise; });
    try {
      await worker.recoverMemoryReviews();
      await reached.promise;
      if (fault === "cancelled") await db.run.update({ where: { id: runId }, data: { status: "cancelled" } });
      else if (fault === "inbox-ineligible") await db.inboxEvent.updateMany({ where: { runId }, data: { status: "pending" } });
      else await db.run.delete({ where: { id: runId } });
    } finally { release.resolve(); await settle(worker); }
    outcomes.push({ fault, inferenceCalls: calls.length, facts: await db.memoryFact.count({ where: { writtenByBotId: bot.id } }) });
  });
  expect(outcomes).toEqual([
    { fault: "cancelled", inferenceCalls: 0, facts: 0 },
    { fault: "inbox-ineligible", inferenceCalls: 0, facts: 0 },
    { fault: "deleted", inferenceCalls: 0, facts: 0 },
  ]);
}, 15_000);
