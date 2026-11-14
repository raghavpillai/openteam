import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Prisma } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { lockAgentLifecycle } from "../src/agent-lifecycle";

const url = process.env.OPENTEAM_LATE_OWNER_TEST_DATABASE_URL ?? process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
type Client = ReturnType<typeof createPrismaClient>;
type Tx = Prisma.TransactionClient;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const input = (runId: string) => ({ runId, user: "Remember that my preferred city is Lisbon.", assistant: "Updated.", timeZone: "UTC" });

async function fixture(work: (f: { prisma: Client; admin: Client; botId: string; runId: string; root: string }) => Promise<void>) {
  const prisma = createPrismaClient(url!), admin = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "memory-late-owner-"));
  const botId = crypto.randomUUID(), runId = crypto.randomUUID();
  try {
    const bot = await prisma.bot.create({ data: {
      id: botId, name: "Late memory owner", status: "active", defaultDirectory: root,
      conversation: { create: {} },
    }, include: { conversation: true } });
    const shared = (await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
    await prisma.run.create({ data: {
      id: runId, botId, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(),
      status: "completed", completedAt: new Date(), memoryReviewPending: true, memoryReviewRevision: bot.memoryRevision + shared,
    } });
    await work({ prisma, admin, botId, runId, root });
  } finally {
    await admin.memoryFact.deleteMany({ where: { namespace: `agent:${botId}` } });
    await admin.event.deleteMany({ where: { entityId: botId } });
    await admin.bot.deleteMany({ where: { id: botId } });
    await Promise.all([prisma.$disconnect(), admin.$disconnect()]);
    await rm(root, { recursive: true, force: true });
  }
}

dbTest("a provider ignoring a heartbeat database abort cannot commit its late extraction response", () => fixture(async ({ prisma, admin, botId, runId, root }) => {
  const aborted = deferred<void>(), release = deferred<string>();
  let killed = false;
  const interrupted = new Proxy(prisma, { get(owner, key) {
    if (key !== "$executeRaw") return Reflect.get(owner, key);
    return async (...args: any[]) => {
      const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
      if (!killed && sql.includes('UPDATE "MemoryReviewLease"')) {
        killed = true;
        return owner.$transaction(async tx => {
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          const [result] = await admin.$queryRaw<Array<{ killed: boolean }>>`SELECT pg_terminate_backend(${backend!.pid}) AS killed`;
          expect(result!.killed).toBe(true);
          return (tx.$executeRaw as any)(...args);
        });
      }
      return (owner.$executeRaw as any)(...args);
    };
  } });
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async request => {
    request.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    // Deliberately ignore cancellation and return a successful provider result.
    return release.promise;
  } });
  const running = learner.recordTurnMemory(botId, input(runId));
  try {
    await aborted.promise;
    expect(killed).toBe(true);
    release.resolve("profile: A late cancelled response must not be saved.");
    expect(await running).toBe(false);
    expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
    expect((await admin.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: runId })]);
    expect(await admin.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
    expect(await admin.memoryReviewLease.count({ where: { botId } })).toBe(0);
    const retry = new AgentDataStore(admin, { root, workspaceRoot: root, memoryInference: async () => "profile: Preferred city is Lisbon." });
    expect(await retry.recordTurnMemory(botId, input(runId))).toBe(true);
    expect(await admin.memoryFact.findMany({ where: { namespace: `agent:${botId}` }, select: { fact: true } })).toEqual([{ fact: "Preferred city is Lisbon." }]);
  } finally {
    release.resolve("NONE");
    await running;
  }
}), 12_000);

dbTest("a former owner ignoring cancellation cannot write or delete a live successor's lease", () => fixture(async ({ prisma, admin, botId, runId, root }) => {
  const firstEntered = deferred<void>(), firstAborted = deferred<void>(), firstRelease = deferred<string>();
  const secondEntered = deferred<void>(), secondRelease = deferred<string>();
  const former = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    request.signal!.addEventListener("abort", () => firstAborted.resolve(), { once: true });
    firstEntered.resolve();
    return firstRelease.promise;
  } });
  const successor = new AgentDataStore(admin, { root, workspaceRoot: root, memoryInference: async () => {
    secondEntered.resolve();
    return secondRelease.promise;
  } });
  const first = former.recordTurnMemory(botId, input(runId));
  let second: Promise<boolean> | undefined;
  try {
    await firstEntered.promise;
    const oldLease = await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    // Model a paused owner missing its TTL. The successor claims through the
    // actual lifecycle/lease SQL, rather than fabricating its owner identity.
    await admin.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${botId}::uuid`;
    second = successor.recordTurnMemory(botId, input(runId));
    await secondEntered.promise;
    const liveLease = await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    expect(liveLease.ownerId).not.toBe(oldLease.ownerId);
    await firstAborted.promise;
    firstRelease.resolve("profile: Stale former owner output.");
    expect(await first).toBe(false);
    expect((await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } })).ownerId).toBe(liveLease.ownerId);
    expect(await admin.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
    expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(true);
    secondRelease.resolve("profile: Preferred city is Lisbon.");
    expect(await second).toBe(true);
    expect(await admin.memoryFact.findMany({ where: { namespace: `agent:${botId}` }, select: { fact: true } })).toEqual([{ fact: "Preferred city is Lisbon." }]);
    expect(await admin.memoryReviewLease.count({ where: { botId } })).toBe(0);
    expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
  } finally {
    firstRelease.resolve("NONE");
    secondRelease.resolve("NONE");
    await Promise.all([first, second]);
  }
}), 12_000);

dbTest("a committed acknowledgement with a lost response is already complete on fresh-client retry", () => fixture(async ({ prisma, admin, botId, runId, root }) => {
  const writer = new AgentDataStore(prisma, { root, workspaceRoot: root });
  const old = await writer.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred city is Boston." });
  let lost = false, inferenceCalls = 0;
  const interrupted = new Proxy(prisma, { get(owner, key) {
    if (key !== "$transaction") return Reflect.get(owner, key);
    return async (work: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      let acknowledged = false;
      const result = await owner.$transaction(tx => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "memoryReviewLease") return Reflect.get(inner, prop);
        return { ...inner.memoryReviewLease, deleteMany: async (args: any) => {
          const value = await inner.memoryReviewLease.deleteMany(args);
          acknowledged = true;
          return value;
        } };
      } })), options as never);
      // The database COMMIT succeeded; only its caller's response is lost.
      if (acknowledged && !lost) { lost = true; throw new Error("Injected lost acknowledgement response after COMMIT"); }
      return result;
    };
  } });
  const learner = new AgentDataStore(interrupted, { root, workspaceRoot: root, memoryInference: async () => {
    inferenceCalls++;
    return 'replace: {"old":"Preferred city is Boston.","fact":"Preferred city is Lisbon."}';
  } });
  expect(await learner.recordTurnMemory(botId, input(runId))).toBe(false);
  expect(lost).toBe(true);
  expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
  expect((await admin.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
  expect(await admin.memoryReviewLease.count({ where: { botId } })).toBe(0);
  const retry = new AgentDataStore(admin, { root, workspaceRoot: root, memoryInference: async () => {
    inferenceCalls++;
    return "profile: A completed exchange must never be inferred twice.";
  } });
  expect(await retry.recordTurnMemory(botId, input(runId))).toBe(true);
  expect(inferenceCalls).toBe(1);
  const facts = await admin.memoryFact.findMany({ where: { namespace: `agent:${botId}` } });
  expect(facts).toHaveLength(2);
  expect(facts.filter(fact => !fact.supersededAt).map(fact => fact.fact)).toEqual(["Preferred city is Lisbon."]);
  expect(facts.find(fact => fact.id === old.id)!.supersededById).toBe(facts.find(fact => !fact.supersededAt)!.id);
}), 10_000);

dbTest("archival racing an in-flight renewal prevents late writes and leaves no renewed orphan lease", () => fixture(async ({ prisma, admin, botId, runId, root }) => {
  const renewing = deferred<void>(), renewalRelease = deferred<void>(), inferenceRelease = deferred<string>();
  let heldRenewal = false;
  const delayed = new Proxy(prisma, { get(owner, key) {
    if (key !== "$executeRaw") return Reflect.get(owner, key);
    return async (...args: any[]) => {
      const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
      if (!heldRenewal && sql.includes('UPDATE "MemoryReviewLease"')) {
        heldRenewal = true;
        return owner.$transaction(async tx => {
          const result = await (tx.$executeRaw as any)(...args);
          renewing.resolve();
          await renewalRelease.promise;
          return result;
        });
      }
      return (owner.$executeRaw as any)(...args);
    };
  } });
  const learner = new AgentDataStore(delayed, { root, workspaceRoot: root, memoryInference: async () => inferenceRelease.promise });
  const running = learner.recordTurnMemory(botId, input(runId));
  try {
    await renewing.promise;
    await admin.$transaction(async tx => {
      await lockAgentLifecycle(tx, botId);
      await tx.bot.update({ where: { id: botId }, data: { status: "archived" } });
    });
    renewalRelease.resolve();
    inferenceRelease.resolve("profile: Archived agent's late response.");
    expect(await running).toBe(true);
    expect(heldRenewal).toBe(true);
    expect(await admin.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
    expect(await admin.memoryReviewLease.count({ where: { botId } })).toBe(0);
    expect((await admin.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending).toBe(false);
    expect((await admin.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
  } finally {
    renewalRelease.resolve();
    inferenceRelease.resolve("NONE");
    await running;
  }
}), 12_000);
