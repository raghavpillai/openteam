import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;

async function fixture(run: (f: { prisma: ReturnType<typeof createPrismaClient>; store: AgentDataStore; botId: string; root: string }) => Promise<void>) {
  const prisma = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "memory-chaos-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: root });
  try {
    await prisma.bot.create({ data: { id: botId, name: "Memory chaos", status: "active", defaultDirectory: root } });
    await run({ prisma, store, botId, root });
  } finally {
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

dbTest("SIGKILL before correction commit rolls back facts, events, cache and revision and releases locks", () => fixture(async ({ prisma, store, botId, root }) => {
  const source = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Calibration mode is red." });
  const before = await prisma.memoryFact.findUniqueOrThrow({ where: { id: source.id } });
  const context = await prisma.contextSession.create({ data: { botId, scope: "home", scopeId: botId, promptSnapshot: { create: {
    promptSections: { memory: { render: "red cached", compactionEpoch: 0 } },
  } } } });
  const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision;
  const events = await prisma.event.count({ where: { entityId: botId } });
  const fact = "Calibration mode is blue.";
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/memory-crash-writer.ts")], {
    env: { PATH: process.env.PATH ?? "", OPENTEAM_TEST_DATABASE_URL: url!, OPENTEAM_MEMORY_CRASH_FIXTURE: JSON.stringify({ botId, sourceId: source.id, fact, root }) },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => { void reader.cancel(); }, 10_000);
  let output = "";
  try {
    while (!output.includes("MEMORY_MUTATION_BEFORE_COMMIT")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain("MEMORY_MUTATION_BEFORE_COMMIT");
    // Outside readers must still see the original committed state.
    expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: source.id } })).toEqual(before);
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(revision);
    expect(await prisma.event.count({ where: { entityId: botId } })).toBe(events);
    expect((await prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: context.id } })).promptSections).toHaveProperty("memory");
    const retry = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: source.id!, fact });
    expect(retry.saved).toBe(true);
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
    expect(await store.recallMemory(botId, { query: "Calibration" })).toContain("blue");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
}), 20_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

dbTest("two stores cannot steal live reviews; an expired owner cannot write or release its successor's backlog", () => fixture(async ({ prisma, botId, root }) => {
  const entered = deferred<void>();
  const response = deferred<string>();
  const first = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered.resolve();
    return response.promise;
  } });
  let calls = 0;
  const second = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    calls++;
    expect(request.prompt).toContain("Remember my favorite tea is oolong.");
    return "profile: Favorite tea is oolong.";
  } });
  const input = { user: "Remember my favorite tea is oolong.", assistant: "Remembered.", runId: crypto.randomUUID() };
  const running = first.recordTurnMemory(botId, input);
  try {
    await entered.promise;
    expect(await second.recordTurnMemory(botId, { ...input, runId: crypto.randomUUID() })).toBe(false);
    expect(calls).toBe(0);
    const oldLease = await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    // Simulate a paused owner missing its TTL, followed by a new owner's claim.
    const newOwner = crypto.randomUUID();
    await prisma.memoryReviewLease.update({ where: { botId }, data: { ownerId: newOwner, expiresAt: new Date(Date.now() + 60_000) } });
    response.resolve("profile: Favorite tea is stale black tea.");
    expect(await running).toBe(false);
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
    expect((await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } })).ownerId).toBe(newOwner);
    const held = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges;
    expect(held).toEqual([expect.objectContaining({ id: input.runId })]);
    expect(oldLease.ownerId).not.toBe(newOwner);
    await prisma.$executeRaw`UPDATE "MemoryReviewLease" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "botId" = ${botId}::uuid`;
    expect(await second.recordTurnMemory(botId, { user: "Remember this preference.", assistant: "Done.", runId: crypto.randomUUID() })).toBe(true);
    expect(calls).toBe(1);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
    expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true } })).toEqual([{ fact: "Favorite tea is oolong." }]);
  } finally {
    response.resolve("");
    await running;
  }
}), 10_000);

dbTest("seeded competing corrections maintain a single active revision and reject late retries across both scopes", () => fixture(async ({ prisma, store, botId }) => {
  let seed = 207;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const scope of ["agent", "user"] as const) {
    let source = await store.writeMemory(botId, { scope, tier: "profile", fact: `${scope} chaos value initial.` });
    for (let round = 0; round < 25; round++) {
      const candidates = Array.from({ length: 2 + random() % 4 }, (_, index) => ({ scope, tier: "profile" as const,
        id: source.id!, fact: `${scope} chaos value ${round}/${index}/${random()}.` }));
      const results = await Promise.allSettled(candidates.map(input => store.replaceMemory(botId, input)));
      const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [{ result: result.value, input: candidates[index]! }] : []);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope, supersededAt: null } });
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(winner.result.id);
      expect(await store.replaceMemory(botId, winner.input)).toEqual(winner.result);
      const previous = source;
      source = winner.result;
      if (round > 0) expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: previous.id } })).supersededById).toBe(source.id!);
    }
    const history = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope } });
    expect(history).toHaveLength(26);
    expect(history.filter(row => row.supersededAt === null)).toHaveLength(1);
    expect(history.filter(row => row.supersededById !== null)).toHaveLength(25);
  }
}), 30_000);

dbTest("inference failures retain exchanges for retry and heartbeat protects a slow review", () => fixture(async ({ prisma, botId, root }) => {
  let calls = 0;
  let firstExpiry = 0;
  const failing = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    calls++;
    const lease = await prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId } });
    if (calls === 1) firstExpiry = lease.expiresAt.getTime();
    if (calls === 3) expect(lease.expiresAt.getTime()).toBeGreaterThan(firstExpiry + 3_000);
    throw new Error("Injected inference connection failure");
  } });
  const input = { user: "Remember my timezone is Europe/Lisbon.", assistant: "Saved.", runId: crypto.randomUUID() };
  expect(await failing.recordTurnMemory(botId, input)).toBe(false);
  expect(calls).toBe(3);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: input.runId })]);
  expect(await prisma.memoryReviewLease.count({ where: { botId } })).toBe(0);
  const healthy = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    expect(request.prompt).toContain(input.user);
    return "profile: Timezone is Europe/Lisbon.";
  } });
  expect(await healthy.recordTurnMemory(botId, input)).toBe(true);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
}), 15_000);

dbTest("durable runs review in order and an acknowledged stale worker cannot override a later correction", () => fixture(async ({ prisma, botId, root, store }) => {
  const conversation = await prisma.conversation.create({ data: { botId } });
  const runs = await Promise.all(Array.from({ length: 6 }, (_, index) => prisma.run.create({ data: {
    botId, conversationId: conversation.id, userMessageId: crypto.randomUUID(), status: "completed", memoryReviewPending: true,
    completedAt: new Date(1_000 + index * 1_000),
  } })));
  let calls = 0;
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    calls++;
    return calls === 1 ? "profile: Preferred tea is black." : "";
  } });
  const input = { user: "Remember preferred tea is black.", assistant: "Saved." };
  // Even when newer workers race first, only the oldest pending Run may review.
  for (const run of runs.slice(1).reverse()) expect(await learner.recordTurnMemory(botId, { ...input, runId: run.id })).toBe(false);
  expect(calls).toBe(0);
  expect(await learner.recordTurnMemory(botId, { ...input, runId: runs[0]!.id })).toBe(true);
  const fact = await prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: botId, supersededAt: null } });
  const correction = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: fact.id, fact: "Preferred tea is oolong." });
  expect(await learner.recordTurnMemory(botId, { ...input, runId: runs[0]!.id })).toBe(true);
  expect(calls).toBe(1);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: correction.id } })).supersededAt).toBeNull();
  for (const run of runs.slice(1)) expect(await learner.recordTurnMemory(botId, { ...input, runId: run.id })).toBe(true);
  expect(calls).toBe(6);
  expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
}), 10_000);

dbTest("replaying an older held exchange preserves chronological latest input and provenance", () => fixture(async ({ prisma, botId, root }) => {
  const older = { id: crypto.randomUUID(), user: "Remember I prefer black tea.", agent: "Saved.", occurredAt: 1_000 };
  const newer = { id: crypto.randomUUID(), user: "Remember I now prefer oolong tea.", agent: "Saved.", occurredAt: 2_000 };
  await prisma.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: [older, newer] } });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    expect(request.prompt).toContain(`Earlier exchange (not yet reviewed):\nUser: ${older.user}`);
    expect(request.prompt).toContain(`Latest exchange:\nUser: ${newer.user}`);
    return "profile: Preferred tea is oolong.";
  } });
  expect(await learner.recordTurnMemory(botId, { user: older.user, assistant: older.agent, occurredAt: older.occurredAt, runId: older.id })).toBe(true);
  const fact = await prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: botId } });
  expect(fact.turnId).toBe(newer.id);
  expect(fact.createdAt.getTime()).toBe(newer.occurredAt);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
}), 10_000);

dbTest("a correction fence survives failed review and also cancels a durable run interrupted before hold", () => fixture(async ({ prisma, botId, root, store }) => {
  const original = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred tea is black." });
  const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
    ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);
  const conversation = await prisma.conversation.create({ data: { botId } });
  const run = await prisma.run.create({ data: { botId, conversationId: conversation.id, userMessageId: crypto.randomUUID(),
    status: "completed", memoryReviewPending: true, memoryReviewRevision: revision, completedAt: new Date() } });
  // A second old exchange represents a crash after hold, before acknowledgement.
  const heldId = crypto.randomUUID();
  await prisma.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: [{ id: heldId,
    user: "Remember I prefer black tea.", agent: "Saved.", occurredAt: 1_000, memoryRevision: revision }] } });
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: original.id!, fact: "Preferred tea is oolong." });
  let calls = 0;
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => { calls++; return "profile: Preferred tea is black."; } });
  expect(await learner.recordTurnMemory(botId, { runId: heldId, user: "Remember I prefer black tea.", assistant: "Saved.", occurredAt: 1_000 })).toBe(true);
  expect(await learner.recordTurnMemory(botId, { runId: run.id, user: "Remember I prefer black tea.", assistant: "Saved.", occurredAt: 1_000 })).toBe(true);
  expect(calls).toBe(0);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: current.id } })).supersededAt).toBeNull();
  expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
}), 10_000);

dbTest("six queued durable corrections advance chronologically without dropping later turns", () => fixture(async ({ prisma, botId, root, store }) => {
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred city is initial." });
  const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
    ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);
  const conversation = await prisma.conversation.create({ data: { botId } });
  const runs = await Promise.all(Array.from({ length: 6 }, (_, index) => prisma.run.create({ data: {
    botId, conversationId: conversation.id, userMessageId: crypto.randomUUID(), status: "completed", memoryReviewPending: true,
    memoryReviewRevision: revision, completedAt: new Date(1_000 + index * 1_000),
  } })));
  let calls = 0;
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    const old = calls === 0 ? "Preferred city is initial." : `Preferred city is city${calls}.`;
    calls++;
    return `replace: ${JSON.stringify({ old, fact: `Preferred city is city${calls}.` })}`;
  } });
  for (const [index, run] of runs.entries()) expect(await learner.recordTurnMemory(botId, {
    runId: run.id, user: `Remember my preferred city is city${index + 1}.`, assistant: "Saved.", occurredAt: 1_000 + index * 1_000,
  })).toBe(true);
  expect(calls).toBe(6);
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { fact: true } }))
    .toEqual([{ fact: "Preferred city is city6." }]);
  expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(7);
}), 10_000);

dbTest("rebasing a learner correction cannot swallow a concurrent peer shared correction fence", () => fixture(async ({ prisma, botId, root, store }) => {
  const peerId = crypto.randomUUID();
  await prisma.bot.create({ data: { id: peerId, name: "Shared correction peer", status: "active", defaultDirectory: root } });
  const ready = deferred<void>(), release = deferred<void>();
  let running: Promise<boolean> | undefined;
  try {
    await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred city is Boston." });
    const sharedFact = await store.writeMemory(peerId, { scope: "user", tier: "profile", fact: "Shared timezone is UTC." });
    const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
      ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);
    const conversation = await prisma.conversation.create({ data: { botId } });
    const runs = await Promise.all([0, 1].map(index => prisma.run.create({ data: { botId, conversationId: conversation.id,
      userMessageId: crypto.randomUUID(), status: "completed", memoryReviewPending: true, memoryReviewRevision: revision,
      completedAt: new Date(1_000 + index * 1_000),
    } })));
    let revisionReads = 0, calls = 0;
    const wrapped = new Proxy(prisma, { get(owner, key) {
      if (key !== "$transaction") return Reflect.get(owner, key);
      return (work: any) => owner.$transaction(async tx => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "bot") return Reflect.get(inner, prop);
        return { ...inner.bot, findUniqueOrThrow: async (input: any) => {
          const value = await inner.bot.findUniqueOrThrow(input);
          if (input.select?.memoryRevision && !input.select.status) { ready.resolve(); await release.promise; }
          return value;
        }, findUnique: async (input: any) => {
          const value = await inner.bot.findUnique(input);
          if (input.select?.memoryRevision && !input.select.status && ++revisionReads === 2) { ready.resolve(); await release.promise; }
          return value;
        } };
      } })), { timeout: 10_000 });
    } });
    const learner = new AgentDataStore(wrapped, { root, workspaceRoot: root, memoryInference: async () => {
      calls++;
      return 'replace: {"old":"Preferred city is Boston.","fact":"Preferred city is Lisbon."}';
    } });
    running = learner.recordTurnMemory(botId, { user: "Remember my city is now Lisbon.", assistant: "Saved.", runId: runs[0]!.id });
    await ready.promise;
    await store.replaceMemory(peerId, { scope: "user", tier: "profile", id: sharedFact.id!, fact: "Shared timezone is Europe/Lisbon." });
    release.resolve();
    expect(await running).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runs[1]!.id } })).memoryReviewRevision).toBe(revision + 1);
    expect(await learner.recordTurnMemory(botId, { user: "Remember my old timezone preference.", assistant: "Saved.", runId: runs[1]!.id })).toBe(true);
    expect(calls).toBe(1);
    expect(await prisma.run.count({ where: { botId, memoryReviewPending: true } })).toBe(0);
  } finally {
    release.resolve();
    await running;
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: peerId } });
    await prisma.bot.deleteMany({ where: { id: peerId } });
  }
}), 15_000);

dbTest("eight shared-memory writers preserve every invalidation under sustained concurrent corrections", () => fixture(async ({ prisma, botId, root, store }) => {
  const ids = [botId, ...Array.from({ length: 7 }, () => crypto.randomUUID())];
  await prisma.bot.createMany({ data: ids.slice(1).map(id => ({ id, name: "Concurrent shared writer", status: "active", defaultDirectory: root })) });
  try {
    const contexts = await Promise.all(ids.map(id => prisma.contextSession.create({ data: { botId: id, scope: "home", scopeId: id,
      promptSnapshot: { create: { promptSections: { memory: { render: "old shared memory", compactionEpoch: 0 } } } },
    } })));
    const before = (await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
    let active = await Promise.all(ids.map(id => store.writeMemory(id.toUpperCase(), {
      scope: "user", tier: "profile", fact: "Concurrent shared calibration stage 0.",
    })));
    for (let round = 1; round <= 8; round++) {
      const next = await Promise.all(ids.map((id, index) => store.replaceMemory(id, {
        scope: "user", tier: round % 2 ? "log" : "profile", id: active[index]!.id!.toUpperCase(), fact: `Concurrent shared calibration stage ${round}.`,
      })));
      expect((await prisma.memoryRevision.findUniqueOrThrow({ where: { scope: "user" } })).revision).toBe(before + round * ids.length);
      const current = await prisma.memoryFact.findMany({ where: { writtenByBotId: { in: ids }, supersededAt: null } });
      expect(current).toHaveLength(ids.length);
      expect(new Set(current.map(row => row.fact))).toEqual(new Set([`Concurrent shared calibration stage ${round}.`]));
      expect(new Set(current.map(row => row.tier))).toEqual(new Set([round % 2 ? "log" : "profile"]));
      for (const [index, previous] of active.entries()) {
        expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: previous.id } })).supersededById).toBe(next[index]!.id);
      }
      active = next;
    }
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: { in: ids } } })).toBe(72);
    expect((await prisma.bot.findMany({ where: { id: { in: ids } }, select: { memoryRevision: true } })).every(bot => bot.memoryRevision === 0)).toBe(true);
    for (const context of contexts) expect((await prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: context.id } })).promptSections).not.toHaveProperty("memory");
    const recalled = await store.recallMemory(botId, { query: "Concurrent shared calibration" });
    expect(recalled).toContain("stage 8.");
    expect(recalled).not.toContain("stage 7.");
  } finally {
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: ids.slice(1) } } });
    await prisma.bot.deleteMany({ where: { id: { in: ids.slice(1) } } });
  }
}), 20_000);
