import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Prisma } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { lockAgentLifecycle } from "../src/agent-lifecycle";

const url = process.env.OPENTEAM_LEASE_FAULT_TEST_DATABASE_URL ?? process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
type Client = ReturnType<typeof createPrismaClient>;
type Tx = Prisma.TransactionClient;
const oldFact = "Preferred city is Boston.";
const newFact = "Preferred city is Lisbon.";
const correction = `replace: ${JSON.stringify({ old: oldFact, fact: newFact })}`;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(work: (f: { prisma: Client; admin: Client; store: AgentDataStore; botId: string; runId: string; root: string }) => Promise<void>) {
  const prisma = createPrismaClient(url!);
  const admin = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "memory-lease-fault-"));
  const botId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: root });
  try {
    const bot = await prisma.bot.create({ data: {
      id: botId, name: "Lease fault fixture", status: "active", defaultDirectory: root,
      conversation: { create: {} },
    }, include: { conversation: true } });
    const shared = (await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
    await prisma.run.create({ data: {
      id: runId, botId, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(),
      status: "completed", completedAt: new Date(), memoryReviewPending: true, memoryReviewRevision: bot.memoryRevision + shared,
    } });
    await work({ prisma, admin, store, botId, runId, root });
  } finally {
    await prisma.memoryFact.deleteMany({ where: { namespace: { in: [`agent:${botId}`, `user:agent:${botId}`] } } });
    await prisma.event.deleteMany({ where: { entityId: botId } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await Promise.all([prisma.$disconnect(), admin.$disconnect()]);
    await rm(root, { recursive: true, force: true });
  }
}

const input = (runId: string) => ({ runId, user: "Remember that my preferred city is now Lisbon.", assistant: "Updated.", timeZone: "UTC" });
const txProxy = (prisma: Client, wrap: (tx: Tx) => Tx): Client => new Proxy(prisma, {
  get(owner, key) {
    if (key !== "$transaction") return Reflect.get(owner, key);
    return (work: (tx: Tx) => Promise<unknown>, options?: unknown) => owner.$transaction(tx => work(wrap(tx)), options as never);
  },
});

/** Terminate only the exact connection currently executing this fixture's transaction. */
async function terminateOwnTransaction(tx: Tx, admin: Client) {
  const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const [result] = await admin.$queryRaw<Array<{ killed: boolean }>>`SELECT pg_terminate_backend(${backend!.pid}) AS killed`;
  expect(result!.killed).toBe(true);
}

dbTest("connection loss after a correction insert rolls back and keeps the durable review retryable", () => fixture(async ({ prisma, admin, store, botId, runId, root }) => {
  const old = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: oldFact });
  let injected = false;
  const interrupted = txProxy(prisma, tx => new Proxy(tx, { get(owner, key) {
    if (key !== "memoryFact") return Reflect.get(owner, key);
    return { ...owner.memoryFact, create: async (args: any) => {
      const result = await owner.memoryFact.create(args);
      if (!injected) { injected = true; await terminateOwnTransaction(owner, admin); }
      return result;
    } };
  } }));
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async () => correction });
  expect(await learner.recordTurnMemory(botId, input(runId))).toBe(false);
  expect(injected).toBe(true);
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { id: true, fact: true, supersededAt: true } }))
    .toEqual([{ id: old.id!, fact: oldFact, supersededAt: null }]);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: runId })]);
  expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
  const recovered = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => correction });
  expect(await recovered.recordTurnMemory(botId, input(runId))).toBe(true);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).supersededById).toBeTruthy();
}), 10_000);

dbTest("connection loss during acknowledgement retains a committed correction without inferring it twice", () => fixture(async ({ prisma, admin, store, botId, runId, root }) => {
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: oldFact });
  let injected = false, inferenceCalls = 0;
  const interrupted = txProxy(prisma, tx => new Proxy(tx, { get(owner, key) {
    if (key !== "memoryReviewLease") return Reflect.get(owner, key);
    return { ...owner.memoryReviewLease, deleteMany: async (args: any) => {
      const result = await owner.memoryReviewLease.deleteMany(args);
      if (!injected) { injected = true; await terminateOwnTransaction(owner, admin); }
      return result;
    } };
  } }));
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async () => { inferenceCalls++; return correction; } });
  const [review] = await Promise.allSettled([learner.recordTurnMemory(botId, input(runId))]);
  expect(injected).toBe(true);
  expect(inferenceCalls).toBe(1);
  expect(await admin.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { fact: true } })).toEqual([{ fact: newFact }]);
  expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
  expect((await admin.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: runId })]);
  // A failed best-effort cleanup may leave its lease until natural expiry.
  // Advance only this fixture's TTL instead of sleeping for thirty seconds.
  await admin.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${botId}::uuid`;
  const fresh = createPrismaClient(url!);
  try {
    const recovered = new AgentDataStore(fresh, { root, workspaceRoot: root, memoryInference: async () => { inferenceCalls++; return "profile: This stale review must never run."; } });
    expect(await recovered.recordTurnMemory(botId, input(runId))).toBe(true);
    expect(inferenceCalls).toBe(1);
    expect(await fresh.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
    expect((await fresh.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
    expect((await fresh.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
    expect(await fresh.memoryReviewLease.count({ where: { botId } })).toBe(0);
  } finally { await fresh.$disconnect(); }
  expect(review).toEqual({ status: "fulfilled", value: false });
}), 10_000);

dbTest("a PostgreSQL heartbeat failure aborts inference and preserves the exchange for a healthy retry", () => fixture(async ({ prisma, admin, botId, runId, root }) => {
  let injected = false, inferenceAborted = false;
  const interrupted = new Proxy(prisma, { get(owner, key) {
    if (key !== "$executeRaw") return Reflect.get(owner, key);
    return async (...args: any[]) => {
      const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
      if (!injected && sql.includes('UPDATE "MemoryReviewLease"')) {
        injected = true;
        return owner.$transaction(async tx => {
          await terminateOwnTransaction(tx, admin);
          return (tx.$executeRaw as any)(...args);
        });
      }
      return (owner.$executeRaw as any)(...args);
    };
  } });
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async request => {
    return await new Promise<string>((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => {
        inferenceAborted = true;
        reject(request.signal!.reason);
      }, { once: true });
    });
  } });
  expect(await learner.recordTurnMemory(botId, input(runId))).toBe(false);
  expect(injected).toBe(true);
  expect(inferenceAborted).toBe(true);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: runId })]);
  expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
  const recovered = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => `profile: ${newFact}` });
  expect(await recovered.recordTurnMemory(botId, input(runId))).toBe(true);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
}), 12_000);

dbTest("a real inference outliving the initial thirty-second lease remains owned through heartbeat renewal", () => fixture(async ({ prisma, botId, runId, root }) => {
  let renewalsObserved = 0;
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    const first = await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    const originalExpiry = first.expiresAt.getTime();
    const [clock] = await prisma.$queryRaw<Array<{ ttl: number }>>`
      SELECT EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp()))::double precision AS ttl
      FROM "MemoryReviewLease" WHERE "botId" = ${botId}::uuid`;
    const originalTtl = clock!.ttl * 1_000;
    expect(originalTtl).toBeGreaterThan(28_000);
    expect(originalTtl).toBeLessThanOrEqual(30_000);
    const began = performance.now();
    let latest = first;
    // Cross the actual production TTL, using normal intervals and database
    // expiry values; no fake clocks or artificially shortened leases here.
    while (performance.now() - began <= originalTtl + 100) {
      await new Promise(resolve => setTimeout(resolve, Math.min(5_500, Math.max(1, originalTtl + 101 - (performance.now() - began)))));
      latest = await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
      expect(latest.ownerId).toBe(first.ownerId);
      const [clock] = await prisma.$queryRaw<Array<{ alive: boolean }>>`
        SELECT "expiresAt" > clock_timestamp() AS alive
        FROM "MemoryReviewLease" WHERE "botId" = ${botId}::uuid`;
      expect(clock!.alive).toBe(true);
      if (latest.expiresAt.getTime() > first.expiresAt.getTime()) renewalsObserved++;
    }
    expect(latest.expiresAt.getTime()).toBeGreaterThan(originalExpiry + 20_000);
    expect(request.signal!.aborted).toBe(false);
    return `profile: ${newFact}`;
  } });
  expect(await learner.recordTurnMemory(botId, input(runId))).toBe(true);
  expect(renewalsObserved).toBeGreaterThanOrEqual(5);
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true } })).toEqual([{ fact: newFact }]);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
  expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
}), 40_000);

dbTest("workers with different PostgreSQL session timezones cannot steal a live review lease", () => fixture(async ({ botId, runId, root }) => {
  const clientIn = (zone: string) => {
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c TimeZone=${zone}`);
    return createPrismaClient(connection.toString());
  };
  const utc = clientIn("UTC"), ahead = clientIn("Pacific/Kiritimati");
  const entered = deferred<void>(), release = deferred<string>();
  let running: Promise<boolean> | undefined;
  let competingInferences = 0;
  try {
    expect(await utc.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`).toEqual([{ zone: "UTC" }]);
    expect(await ahead.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`).toEqual([{ zone: "Pacific/Kiritimati" }]);
    const owner = new AgentDataStore(utc, { root, workspaceRoot: root, memoryInference: async () => {
      entered.resolve();
      return release.promise;
    } });
    const competitor = new AgentDataStore(ahead, { root, workspaceRoot: root, memoryInference: async () => {
      competingInferences++;
      return "NONE";
    } });
    running = owner.recordTurnMemory(botId, input(runId));
    await entered.promise;
    const original = await utc.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    const outcome = await competitor.recordTurnMemory(botId, input(runId));
    // Both clients use database time, but the timestamp column must retain
    // the same instant when interpreted by their different session timezones.
    expect({ outcome, competingInferences }).toEqual({ outcome: false, competingInferences: 0 });
    expect((await utc.memoryReviewLease.findUniqueOrThrow({ where: { botId } })).ownerId).toBe(original.ownerId);
    release.resolve(`profile: ${newFact}`);
    expect(await running).toBe(true);
    expect(await utc.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true } })).toEqual([{ fact: newFact }]);
  } finally {
    release.resolve("NONE");
    await running;
    await Promise.all([utc.$disconnect(), ahead.$disconnect()]);
  }
}), 10_000);

dbTest("expiry inside a locked mutation cannot erase durable retry work after the correction commits", () => fixture(async ({ prisma, store, botId, runId, root }) => {
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: oldFact });
  let expired = false, inferenceCalls = 0;
  const interrupted = txProxy(prisma, tx => new Proxy(tx, { get(owner, key) {
    if (key !== "memoryFact") return Reflect.get(owner, key);
    return { ...owner.memoryFact, create: async (args: any) => {
      const result = await owner.memoryFact.create(args);
      if (!expired) {
        expired = true;
        // The ownership check already holds this row FOR UPDATE. Shorten the
        // TTL on its own connection to simulate a transaction crossing expiry.
        await owner.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${botId}::uuid`;
      }
      return result;
    } };
  } }));
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async () => { inferenceCalls++; return correction; } });
  expect(await learner.recordTurnMemory(botId, input(runId))).toBe(false);
  expect(expired).toBe(true);
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { fact: true } })).toEqual([{ fact: newFact }]);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
  const recovered = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => { inferenceCalls++; return "profile: Stale output."; } });
  expect(await recovered.recordTurnMemory(botId, input(runId))).toBe(true);
  expect(inferenceCalls).toBe(1);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
}), 10_000);

for (const retirement of ["archive", "delete"] as const) {
  dbTest(`${retirement} during inference prevents late extraction from writing facts or recreating its lease`, () => fixture(async ({ prisma, botId, runId, root }) => {
    const entered = deferred<void>(), release = deferred<string>();
    const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
      entered.resolve();
      return release.promise;
    } });
    const running = learner.recordTurnMemory(botId, input(runId));
    try {
      await entered.promise;
      await prisma.$transaction(async tx => {
        await lockAgentLifecycle(tx, botId);
        if (retirement === "archive") await tx.bot.update({ where: { id: botId }, data: { status: "archived" } });
        else await tx.bot.delete({ where: { id: botId } });
      });
      release.resolve(`profile: ${newFact}`);
      expect(await running).toBe(retirement === "archive");
      expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
      expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
      if (retirement === "archive") {
        expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
        expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
      } else expect(await prisma.bot.findUnique({ where: { id: botId } })).toBeNull();
    } finally {
      release.resolve("NONE");
      await running;
    }
  }), 10_000);
}
