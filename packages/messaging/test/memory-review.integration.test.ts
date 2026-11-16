// Durable memory review on PostgreSQL: the per-bot review lease, retry after outages and
// connection faults, ordering of queued reviews, and correction fences.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Prisma } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { lockAgentLifecycle } from "../src/agent-lifecycle";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
type Client = ReturnType<typeof createPrismaClient>;
type Tx = Prisma.TransactionClient;
type Infer = (request: { prompt: string; signal?: AbortSignal }) => Promise<string>;
const oldFact = "Preferred city is Boston.";
const newFact = "Preferred city is Lisbon.";
const correction = `replace: ${JSON.stringify({ old: oldFact, fact: newFact })}`;
const gate = <T = void>() => Promise.withResolvers<T>();
const input = (runId: string) => ({ runId, user: "Remember that my preferred city is now Lisbon.", assistant: "Updated.", timeZone: "UTC" });

type Fixture = {
  prisma: Client; admin: Client; store: AgentDataStore; botId: string; root: string;
  learner(infer: Infer, db?: Client): AgentDataStore;
  /** A completed Run with a completed inbox, pending review at the current revision. */
  pendingRun(completedAt?: Date): Promise<string>;
  revision(): Promise<number>;
  held(): Promise<unknown>;
};

function fixture(work: (f: Fixture) => Promise<void>) {
  return async () => {
    const prisma = createPrismaClient(url!), admin = createPrismaClient(url!);
    const root = await mkdtemp(join(tmpdir(), "memory-review-"));
    const botId = crypto.randomUUID();
    const store = new AgentDataStore(prisma, { root, workspaceRoot: root });
    try {
      const bot = await prisma.bot.create({ data: { id: botId, name: "Memory review", status: "active", defaultDirectory: root, conversation: { create: {} } },
        include: { conversation: true } });
      const revision = async () => (await admin.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
        ((await admin.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);
      await work({ prisma, admin, store, botId, root, revision,
        learner: (infer, db = prisma) => new AgentDataStore(db, { root, workspaceRoot: root, memoryInference: request => infer(request) }),
        held: async () => (await admin.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges,
        pendingRun: async (completedAt = new Date()) => (await prisma.run.create({ data: {
          botId, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "completed", completedAt,
          memoryReviewPending: true, memoryReviewRevision: await revision(),
          inboxEvents: { create: { botId, conversationId: bot.conversation!.id, idempotencyKey: `memory-review:${crypto.randomUUID()}`,
            type: "message.created", payload: {}, status: "completed" } },
        } })).id,
      });
    } finally {
      await admin.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
      await admin.event.deleteMany({ where: { entityId: botId } });
      await admin.bot.deleteMany({ where: { id: botId } });
      await Promise.all([prisma.$disconnect(), admin.$disconnect()]);
      await rm(root, { recursive: true, force: true });
    }
  };
}

const facts = (db: Client, botId: string) =>
  db.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, orderBy: { sourceOrdinal: "asc" }, select: { fact: true } });
const pending = async (db: Client, runId: string) => (await db.run.findUniqueOrThrow({ where: { id: runId } })).memoryReviewPending;
const txProxy = (prisma: Client, wrap: (tx: Tx) => Tx): Client => new Proxy(prisma, { get(owner, key) {
  if (key !== "$transaction") return Reflect.get(owner, key);
  return (work: (tx: Tx) => Promise<unknown>, options?: unknown) => owner.$transaction(tx => work(wrap(tx)), options as never);
} });
/** Terminate only the connection running this transaction. */
async function terminateOwnTransaction(tx: Tx, admin: Client) {
  const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  expect((await admin.$queryRaw<Array<{ killed: boolean }>>`SELECT pg_terminate_backend(${backend!.pid}) AS killed`)[0]!.killed).toBe(true);
}
const expireLease = (db: Client, botId: string) =>
  db.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${botId}::uuid`;

dbTest("a durable review lease serializes overlapping exchanges, and the next review takes over an abandoned one", fixture(async ({ prisma, botId, learner, held }) => {
  const prompts: string[] = [];
  const started = gate(), finish = gate();
  const store = learner(async request => {
    prompts.push(request.prompt);
    if (request.prompt.includes("Overlap one.") && !request.prompt.includes("Earlier exchange")) { started.resolve(); await finish.promise; }
    return "";
  });
  const first = store.recordTurnMemory(botId, { user: "Remember overlap one.", assistant: "Overlap one.", runId: crypto.randomUUID() });
  await started.promise;
  const second = { user: "Remember overlap two.", assistant: "Overlap two.", runId: crypto.randomUUID() };
  expect(await store.recordTurnMemory(botId, second)).toBe(false);
  expect(prompts).toHaveLength(1);
  finish.resolve();
  expect(await first).toBe(true);
  expect(await store.recordTurnMemory(botId, second)).toBe(true);
  expect(await held()).toEqual([]);
  // An exchange held by a process that stopped mid-review is reviewed with the next one.
  await prisma.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: [{ id: "abandoned", user: "Abandoned detail.", agent: "Held." }] } });
  await store.recordTurnMemory(botId, { user: "Remember overlap three.", assistant: "Overlap three.", runId: crypto.randomUUID() });
  expect(prompts.at(-1)).toContain("Earlier exchange (not yet reviewed):\nUser: Abandoned detail.");
  expect(await held()).toEqual([]);
}));

dbTest("an owner that outlived its lease cannot write, acknowledge or release its successor's review", fixture(async ({ admin, botId, learner, pendingRun }) => {
  const runId = await pendingRun();
  const firstEntered = gate(), firstRelease = gate<string>(), secondEntered = gate(), secondRelease = gate<string>();
  const first = learner(async () => { firstEntered.resolve(); return firstRelease.promise; }).recordTurnMemory(botId, input(runId));
  let second: Promise<boolean> | undefined;
  try {
    await firstEntered.promise;
    const oldLease = await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    await expireLease(admin, botId);
    second = learner(async () => { secondEntered.resolve(); return secondRelease.promise; }, admin).recordTurnMemory(botId, input(runId));
    await secondEntered.promise;
    const live = await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    expect(live.ownerId).not.toBe(oldLease.ownerId);
    firstRelease.resolve("profile: Stale former owner output.");
    expect(await first).toBe(false);
    expect((await admin.memoryReviewLease.findUniqueOrThrow({ where: { botId } })).ownerId).toBe(live.ownerId);
    expect(await facts(admin, botId)).toEqual([]);
    expect(await pending(admin, runId)).toBe(true);
    secondRelease.resolve(`profile: ${newFact}`);
    expect(await second).toBe(true);
    expect(await facts(admin, botId)).toEqual([{ fact: newFact }]);
    expect(await pending(admin, runId)).toBe(false);
    expect(await admin.memoryReviewLease.count({ where: { botId } })).toBe(0);
  } finally {
    firstRelease.resolve("NONE"); secondRelease.resolve("NONE");
    await Promise.allSettled([first, second]);
  }
}));

dbTest("an inference outage keeps the exchange for retry, renews the lease while retrying, and releases it after", fixture(async ({ prisma, botId, learner, held }) => {
  let calls = 0, firstExpiry = 0;
  const run = { user: "Remember my timezone is Europe/Lisbon.", assistant: "Saved.", runId: crypto.randomUUID() };
  expect(await learner(async () => {
    calls++;
    const lease = await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    if (calls === 1) firstExpiry = lease.expiresAt.getTime();
    if (calls === 3) expect(lease.expiresAt.getTime()).toBeGreaterThan(firstExpiry + 3_000);
    throw new Error("Injected inference outage");
  }).recordTurnMemory(botId, run)).toBe(false);
  expect(calls).toBe(3);
  expect(await held()).toEqual([expect.objectContaining({ id: run.runId })]);
  expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
  expect(await learner(async request => { expect(request.prompt).toContain(run.user); return "profile: Timezone is Europe/Lisbon."; })
    .recordTurnMemory(botId, run)).toBe(true);
  expect(await held()).toEqual([]);
  expect(await facts(prisma, botId)).toEqual([{ fact: "Timezone is Europe/Lisbon." }]);
}));

dbTest("a transient provider failure is retried with the same prompt and its result published", fixture(async ({ prisma, botId, learner, held }) => {
  const prompts: string[] = [];
  expect(await learner(async request => {
    prompts.push(request.prompt);
    if (prompts.length === 1) throw new Error("Synthetic transient provider outage");
    return "profile: The synthetic calibration color is blue.";
  }).recordTurnMemory(botId, { user: "Remember the synthetic calibration color is blue.", assistant: "Recorded blue." })).toBe(true);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toBe(prompts[0]);
  expect(await facts(prisma, botId)).toEqual([{ fact: "The synthetic calibration color is blue." }]);
  expect(await held()).toEqual([]);
}));

for (const scope of ["agent", "user"] as const) {
  dbTest(`a correction in ${scope} memory during retry backoff stops the obsolete retry`, fixture(async ({ prisma, store, botId, learner, held }) => {
    const entered = gate();
    let attempts = 0;
    const original = await store.writeMemory(botId, { scope, tier: "profile", fact: "The synthetic calibration color is red." });
    const review = learner(async () => {
      if (++attempts === 1) { entered.resolve(); throw new Error("Synthetic malformed provider response"); }
      return "profile: The synthetic calibration color is red.";
    }).recordTurnMemory(botId, { user: "Remember the synthetic calibration color is red.", assistant: "Recorded red." });
    await entered.promise;
    await store.replaceMemory(botId, { scope, tier: "profile", id: original.id!, fact: "The synthetic calibration color is blue." });
    expect(await review).toBe(true);
    expect(attempts).toBe(1);
    expect(await facts(prisma, botId)).toEqual([{ fact: "The synthetic calibration color is blue." }]);
    expect(await held()).toEqual([]);
    expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
  }));
}

dbTest("connection loss after a correction insert rolls back and keeps the durable review retryable", fixture(async ({ prisma, admin, store, botId, learner, pendingRun, held }) => {
  const runId = await pendingRun();
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
  expect(await learner(async () => correction, interrupted).recordTurnMemory(botId, input(runId))).toBe(false);
  expect(injected).toBe(true);
  expect(await admin.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { id: true, supersededAt: true } })).toEqual([{ id: old.id!, supersededAt: null }]);
  expect(await pending(admin, runId)).toBe(true);
  expect(await held()).toEqual([expect.objectContaining({ id: runId })]);
  expect(await learner(async () => correction, admin).recordTurnMemory(botId, input(runId))).toBe(true);
  expect(await facts(admin, botId)).toEqual([{ fact: newFact }]);
}));

dbTest("connection loss during acknowledgement keeps the committed correction, and the retry does not infer it again", fixture(async ({ prisma, admin, store, botId, learner, pendingRun, held }) => {
  const runId = await pendingRun();
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
  expect(await learner(async () => { inferenceCalls++; return correction; }, interrupted).recordTurnMemory(botId, input(runId))).toBe(false);
  expect(injected).toBe(true);
  expect(await facts(admin, botId)).toEqual([{ fact: newFact }]);
  expect(await pending(admin, runId)).toBe(true);
  // A failed cleanup may leave the lease until it expires; skip the wait.
  await expireLease(admin, botId);
  expect(await learner(async () => { inferenceCalls++; return "profile: This stale review must never run."; }, admin).recordTurnMemory(botId, input(runId))).toBe(true);
  expect(inferenceCalls).toBe(1);
  expect(await admin.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
  expect(await pending(admin, runId)).toBe(false);
  expect(await held()).toEqual([]);
}));

for (const retirement of ["archive", "delete"] as const) {
  dbTest(`${retirement} during inference stops the late extraction from writing facts or recreating its lease`, fixture(async ({ prisma, botId, learner, pendingRun }) => {
    const runId = await pendingRun();
    const entered = gate(), release = gate<string>();
    const running = learner(async () => { entered.resolve(); return release.promise; }).recordTurnMemory(botId, input(runId));
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
      if (retirement === "archive") expect(await pending(prisma, runId)).toBe(false);
    } finally {
      release.resolve("NONE");
      await running;
    }
  }));
}

dbTest("queued runs review oldest first, an acknowledged run is never reviewed again, and a correction fences older exchanges", fixture(async ({ prisma, store, botId, learner, pendingRun }) => {
  const runs = [];
  for (let index = 0; index < 3; index++) runs.push(await pendingRun(new Date(1_000 + index * 1_000)));
  let calls = 0;
  const reviewer = learner(async () => ++calls === 1 ? "profile: Preferred tea is black." : "");
  const turn = (runId: string) => reviewer.recordTurnMemory(botId, { user: "Remember preferred tea is black.", assistant: "Saved.", runId });
  // Newer runs racing first wait for the oldest pending one.
  for (const runId of runs.slice(1).reverse()) expect(await turn(runId)).toBe(false);
  expect(calls).toBe(0);
  expect(await turn(runs[0]!)).toBe(true);
  expect(await turn(runs[0]!)).toBe(true);
  expect(calls).toBe(1);
  // A correction after a run settled, or after its exchange was held, cancels that stale review.
  const fact = await prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: botId, supersededAt: null } });
  const revision = (await prisma.run.findUniqueOrThrow({ where: { id: runs[1]! } })).memoryReviewRevision;
  await prisma.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: [{ id: "held-before-correction",
    user: "Remember I prefer black tea.", agent: "Saved.", occurredAt: 500, memoryRevision: revision }] } });
  const corrected = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: fact.id, fact: "Preferred tea is oolong." });
  expect(await reviewer.recordTurnMemory(botId, { runId: "held-before-correction", user: "Remember I prefer black tea.", assistant: "Saved.", occurredAt: 500 })).toBe(true);
  for (const runId of runs.slice(1)) expect(await turn(runId)).toBe(true);
  expect(calls).toBe(1);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).supersededAt).toBeNull();
  expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
}));

dbTest("the learner's own corrections advance later queued runs instead of fencing them", fixture(async ({ prisma, store, botId, learner, pendingRun }) => {
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred city is initial." });
  const runs = [await pendingRun(new Date(1_000)), await pendingRun(new Date(2_000))];
  let calls = 0;
  const reviewer = learner(async () => {
    const old = calls === 0 ? "Preferred city is initial." : `Preferred city is city${calls}.`;
    calls++;
    return `replace: ${JSON.stringify({ old, fact: `Preferred city is city${calls}.` })}`;
  });
  for (const [index, runId] of runs.entries())
    expect(await reviewer.recordTurnMemory(botId, { runId, user: `Remember my preferred city is city${index + 1}.`, assistant: "Saved.", occurredAt: 1_000 + index * 1_000 })).toBe(true);
  expect(calls).toBe(2);
  expect(await facts(prisma, botId)).toEqual([{ fact: "Preferred city is city2." }]);
  expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
}));

dbTest("replaying an older held exchange keeps the newest as the latest input and its provenance", fixture(async ({ prisma, botId, learner, held }) => {
  const older = { id: crypto.randomUUID(), user: "Remember I prefer black tea.", agent: "Saved.", occurredAt: 1_000 };
  const newer = { id: crypto.randomUUID(), user: "Remember I now prefer oolong tea.", agent: "Saved.", occurredAt: 2_000 };
  await prisma.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: [older, newer] } });
  expect(await learner(async request => {
    expect(request.prompt).toContain(`Earlier exchange (not yet reviewed):\nUser: ${older.user}`);
    expect(request.prompt).toContain(`Latest exchange:\nUser: ${newer.user}`);
    return "profile: Preferred tea is oolong.";
  }).recordTurnMemory(botId, { user: older.user, assistant: older.agent, occurredAt: older.occurredAt, runId: older.id })).toBe(true);
  const fact = await prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: botId } });
  expect(fact.turnId).toBe(newer.id);
  expect(fact.createdAt.getTime()).toBe(newer.occurredAt);
  expect(await held()).toEqual([]);
}));
