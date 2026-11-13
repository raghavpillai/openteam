import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
const revisionOf = async (prisma: ReturnType<typeof createPrismaClient>, botId: string) =>
  (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
  ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);


async function fixture(run: (f: {
  prisma: ReturnType<typeof createPrismaClient>;
  store: AgentDataStore;
  botId: string;
  peerId: string;
  root: string;
}) => Promise<void>) {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-adversarial-"));
  const botId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
  try {
    await prisma.bot.createMany({ data: [botId, peerId].map(id => ({
      id, name: "Adversarial memory", status: "active", defaultDirectory: root,
    })) });
    await run({ prisma, store, botId, peerId, root });
  } finally {
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
    await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

for (const scope of ["agent", "user"] as const) {
  for (const tier of ["profile", "log"] as const) {
    dbTest(`replacement honors requested ${scope}/${tier} type when an identical target already exists`, () => fixture(async ({ prisma, store, botId }) => {
      const old = await store.writeMemory(botId, { scope, tier: "profile", fact: "The calibration color is red." });
      const target = await store.writeMemory(botId, {
        scope, tier: tier === "profile" ? "log" : "profile", fact: "The calibration color is blue.",
      });
      const result = await store.replaceMemory(botId, {
        scope, tier, id: old.id!, fact: "The calibration color is blue.",
      });
      const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope, supersededAt: null } });
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(result.id);
      expect(active[0]!.tier).toBe(tier);
      expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).supersededById).toBe(result.id);
      const oldTarget = await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.id } });
      expect(oldTarget.supersededAt).toBeInstanceOf(Date);
      expect(oldTarget.supersededById).toBe(result.id);
      // Reclassifying the target must leave exactly one active corrected value.
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: "The calibration color is blue.", supersededAt: null } })).toBe(1);
    }));

    dbTest(`same-text replacement applies a changed ${scope}/${tier} type and invalidates prompts`, () => fixture(async ({ prisma, store, botId }) => {
      const fact = "The calibration color is blue.";
      const old = await store.writeMemory(botId, { scope, tier: tier === "profile" ? "log" : "profile", fact });
      const revision = await revisionOf(prisma, botId);
      const input = { scope, tier, id: old.id!, fact };
      const result = await store.replaceMemory(botId, input);
      expect(result.saved).toBe(true);
      const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope, supersededAt: null } });
      expect(active.map(row => ({ fact: row.fact, tier: row.tier }))).toEqual([{ fact, tier }]);
      const previous = await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } });
      expect(previous.supersededAt).toBeInstanceOf(Date);
      expect(previous.supersededById).toBe(result.id);
      expect(await revisionOf(prisma, botId)).toBe(revision + 1);
      const retry = await store.replaceMemory(botId, input);
      expect(retry.id).toBe(result.id);
      expect(await revisionOf(prisma, botId)).toBe(revision + 1);
    }));

    dbTest(`a retired ${scope} source id cannot silently accept a conflicting ${tier} retry type`, () => fixture(async ({ prisma, store, botId }) => {
      const old = await store.writeMemory(botId, { scope, tier: "profile", fact: "The calibration color is red." });
      const appliedTier = tier === "profile" ? "log" : "profile";
      const fact = "The calibration color is blue.";
      const result = await store.replaceMemory(botId, { scope, tier: appliedTier, id: old.id!, fact });
      const revision = await revisionOf(prisma, botId);
      // A changed type makes this a new request against an obsolete source, not
      // an idempotent retry of the successful correction.
      await expect(store.replaceMemory(botId, { scope, tier, id: old.id!, fact })).rejects.toThrow("superseded");
      const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope, supersededAt: null } });
      expect(active.map(row => ({ id: row.id, tier: row.tier }))).toEqual([{ id: result.id, tier: appliedTier }]);
      expect(await revisionOf(prisma, botId)).toBe(revision);
    }));
  }
}

dbTest("extraction can merge several existing facts and independently retire another in one response", () => fixture(async ({ prisma, store, botId, root }) => {
  const previous = ["Lives in Boston.", "Works from Boston."];
  const removed = "The temporary office access code is 1234.";
  const current = "Lives and works in Lisbon.";
  for (const fact of [...previous, removed]) await store.writeMemory(botId, { scope: "agent", tier: "profile", fact });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    for (const fact of [...previous, removed]) expect(request.prompt).toContain(fact);
    return [
      ...previous.map(old => `replace: ${JSON.stringify({ old, fact: current })}`),
      `remove: ${removed}`,
      "profile: Prefers afternoon meetings.",
    ].join("\n");
  } });
  await learner.recordTurnMemory(botId, {
    user: "I moved both home and work to Lisbon; forget the old office code. I prefer afternoon meetings.",
    assistant: "Updated.", runId: "merged-extraction",
  });
  const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null } });
  expect(active.map(row => row.fact).sort()).toEqual([current, "Prefers afternoon meetings."].sort());
  const replacement = active.find(row => row.fact === current)!;
  expect(replacement.turnId).toBe("merged-extraction");
  const history = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: { not: null } } });
  expect(history).toHaveLength(3);
  expect(history.filter(row => previous.includes(row.fact)).map(row => row.supersededById)).toEqual([replacement.id, replacement.id]);
  expect(history.find(row => row.fact === removed)!.supersededById).toBeNull();
}));

dbTest("an extracted durable correction promotes an identical journal target to profile", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = "Lives in Boston.";
  const current = "Lives in Lisbon.";
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: old });
  await store.writeMemory(botId, { scope: "agent", tier: "log", fact: current });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () =>
    `replace: ${JSON.stringify({ old, fact: current })}`,
  });
  await learner.recordTurnMemory(botId, { user: "Please correct my permanent address to Lisbon.", assistant: "Updated." });
  const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null } });
  expect(active.map(row => ({ fact: row.fact, tier: row.tier }))).toEqual([{ fact: current, tier: "profile" }]);
}));

dbTest("identical concurrent retries return one correction without extra invalidations or events", () => fixture(async ({ prisma, store, botId }) => {
  const old = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred editor is Vim." });
  const before = await revisionOf(prisma, botId);
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: "Preferred editor is Emacs." };
  const first = await store.replaceMemory(botId, input);
  const eventsAfterFirst = await prisma.event.count({ where: { entityId: botId, topic: "memory.changed" } });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.replaceMemory(botId, input)));
  for (const result of results) expect(result).toEqual(first);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
  expect(await revisionOf(prisma, botId)).toBe(before + 1);
  expect(await prisma.event.count({ where: { entityId: botId, topic: "memory.changed" } })).toBe(eventsAfterFirst);
}));

dbTest("a retry cannot resurrect its old result after that result was itself corrected or forgotten", () => fixture(async ({ prisma, store, botId }) => {
  const old = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred editor is Vim." });
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: "Preferred editor is Emacs." };
  const first = await store.replaceMemory(botId, input);
  const latest = await store.replaceMemory(botId, { ...input, id: first.id, fact: "Preferred editor is Zed." });
  await expect(store.replaceMemory(botId, input)).rejects.toThrow("superseded");
  expect((await store.listBotMemories(botId)).memories.map(row => row.content)).toEqual(["Preferred editor is Zed."]);
  await store.forgetMemory(botId, { scope: "agent", fact: "Preferred editor is Zed." });
  await expect(store.replaceMemory(botId, { ...input, id: first.id, fact: "Preferred editor is Zed." })).rejects.toThrow("superseded");
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(0);
  expect(latest.id).not.toBe(first.id);
}));

dbTest("a peer correction refreshes shared memory after an older prompt preparation finishes late", () => fixture(async ({ prisma, store, botId, peerId }) => {
  await store.initializeBot(peerId);
  const context = await prisma.contextSession.create({ data: { botId: peerId, scope: "home", scopeId: peerId } });
  const old = await store.writeMemory(botId, { scope: "user", tier: "profile", fact: "Shared home city is Boston." });
  const stale = await store.promptContext(peerId, context.id);
  expect(stale.memory.facts).toContain("Shared home city is Boston.");
  await store.replaceMemory(botId, { scope: "user", tier: "profile", id: old.id!, fact: "Shared home city is Lisbon." });
  await store.preparePlatformSections(peerId, context.id, stale.compactionEpoch, {}, stale.memory);
  const live = await store.promptContext(peerId, context.id);
  expect(live.compactionEpoch).toBe(stale.compactionEpoch);
  const next = await store.preparePlatformSections(peerId, context.id, live.compactionEpoch, {}, live.memory);
  expect(next.memory!.facts).toContain("Shared home city is Lisbon.");
  expect(next.memory!.facts).not.toContain("Shared home city is Boston.");
}));
