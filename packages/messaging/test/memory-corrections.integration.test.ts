import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { lockAgentLifecycle } from "../src/agent-lifecycle";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
const oldFact = "My favourite football player is Ronaldo.";
const newFact = "My favourite player is now Messi.";
const query = "Who is my favourite football player?";

async function fixture(run: (f: {
  prisma: ReturnType<typeof createPrismaClient>; store: AgentDataStore; botId: string; peerId: string; root: string;
}) => Promise<void>) {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-corrections-"));
  const botId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
  try {
    await prisma.bot.createMany({ data: [botId, peerId].map(id => ({ id, name: "Memory corrections", status: "active", defaultDirectory: root })) });
    await run({ prisma, store, botId, peerId, root });
  } finally {
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
    await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

const write = (store: AgentDataStore, botId: string, fact = oldFact, scope: "agent" | "user" = "agent") =>
  store.writeMemory(botId, { scope, tier: "profile", fact });

// These are PostgreSQL-backed regressions, including real advisory locks and transactions.
dbTest("#207: a paraphrased correction excludes the more lexically relevant stale fact before ranking", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  expect(await store.recallMemory(botId, { query })).toContain(`id: ${old.id}; active`);
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact }, { source: "tool", turnId: "correction-turn" });
  const result = await store.recallMemory(botId, { query, limit: 1 });
  expect(result).toContain("Messi");
  expect(result).not.toContain("Ronaldo");
  const history = await store.recallMemory(botId, { query, includeHistory: true });
  expect(history).toContain("Ronaldo");
  expect(history).toContain(`by ${current.id}`);
  expect(history).toContain("superseded");
  const oldRow = await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } });
  expect(oldRow.supersededById).toBe(current.id);
  expect(oldRow.supersededAt).toBeInstanceOf(Date);
  expect((await store.listBotMemories(botId)).memories.map(row => row.content)).toEqual([newFact]);
  const currentRow = await prisma.memoryFact.findUniqueOrThrow({ where: { id: current.id } });
  expect(currentRow.turnId).toBe("correction-turn");
}));

dbTest("competing corrections serialize and a stale correction never appends a third active value", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const results = await Promise.allSettled([newFact, "My favourite player is Neymar."].map(fact =>
    store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
}));

dbTest("replacement retries are idempotent; replacing with the same text is a no-op", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  expect((await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: oldFact })).saved).toBe(false);
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: newFact };
  const first = await store.replaceMemory(botId, input);
  expect(await store.replaceMemory(botId, input)).toEqual(first);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
}));

dbTest("replacement enforces bot and scope ownership and rejects empty or invalid targets", () => fixture(async ({ prisma, store, botId, peerId }) => {
  const old = await write(store, botId);
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: newFact };
  await expect(store.replaceMemory(peerId, input)).rejects.toThrow("unavailable");
  await expect(store.replaceMemory(botId, { ...input, scope: "user" })).rejects.toThrow("unavailable");
  await expect(store.replaceMemory(botId, { ...input, id: "not-an-id" })).rejects.toThrow("fact id");
  await expect(store.replaceMemory(botId, { ...input, fact: "   " })).rejects.toThrow("empty");
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
}));

dbTest("an existing identical target is reused; returning to a previous value creates a new revision", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const existing = await write(store, botId, newFact);
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  expect(current.id).toBe(existing.id!);
  const restored = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: current.id, fact: oldFact });
  expect(restored.id).not.toBe(old.id!);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
  const history = await store.recallMemory(botId, { query, includeHistory: true });
  expect(history).toContain(`id: ${restored.id}; active`);
  expect(history).toContain(`id: ${old.id}; superseded`);
}));

dbTest("correction and forget invalidate pinned memory immediately, including peers' shared snapshots", () => fixture(async ({ prisma, store, botId, peerId }) => {
  for (const id of [botId, peerId]) {
    await prisma.contextSession.create({ data: { botId: id, scope: "home", scopeId: id,
      promptSnapshot: { create: { promptSections: { memory: { render: "stale memory", compactionEpoch: 0 }, automations: { render: "keep", compactionEpoch: 0 } } } },
    } });
  }
  const own = await write(store, botId);
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: own.id!, fact: newFact });
  const snapshots = () => prisma.contextPromptSnapshot.findMany({ where: { contextSession: { botId: { in: [botId, peerId] } } }, include: { contextSession: true } });
  let rows = await snapshots();
  expect(rows.find(row => row.contextSession.botId === botId)!.promptSections).not.toHaveProperty("memory");
  expect(rows.find(row => row.contextSession.botId === peerId)!.promptSections).toHaveProperty("memory");
  const shared = await write(store, botId, oldFact, "user");
  await store.replaceMemory(botId, { scope: "user", tier: "profile", id: shared.id!, fact: newFact });
  rows = await snapshots();
  for (const row of rows) {
    expect(row.promptSections).not.toHaveProperty("memory");
    expect(row.promptSections).toHaveProperty("automations");
  }
  expect(await store.recallMemory(peerId, { query })).not.toContain("Ronaldo");
  await store.forgetMemory(botId, { scope: "agent", fact: oldFact });
  expect(await store.recallMemory(botId, { query, includeHistory: true })).not.toContain(`[profile] ${oldFact}`);
}));

dbTest("automatic extraction applies an explicit correction and records the replacement history", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = await write(store, botId);
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    expect(request.instructions).toContain("Additional preferences are not replacements");
    return `replace: ${JSON.stringify({ old: oldFact, fact: newFact })}`;
  } });
  await learner.recordTurnMemory(botId, { user: "My favourite football player is now Messi.", assistant: "Understood.", runId: "learned-correction" });
  expect(await store.recallMemory(botId, { query })).not.toContain("Ronaldo");
  expect(await store.recallMemory(botId, { query })).toContain("Messi");
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).supersededById).toBeTruthy();
}));

dbTest("delayed extraction cannot replace a fact already corrected by a concurrent tool write", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = await write(store, botId);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `replace: ${JSON.stringify({ old: oldFact, fact: "My favourite player is Neymar." })}`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: "My favourite player is Neymar now.", assistant: "Okay." });
  try {
    await started;
    await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  } finally { release(); await learning; }
  expect(await store.recallMemory(botId, { query })).toContain("Messi");
  expect(await store.recallMemory(botId, { query })).not.toContain("Neymar");
}));

dbTest("a retirement failure rolls back the new fact and leaves the previous fact active", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  // A real database constraint fails after insertion, exercising transaction rollback.
  await prisma.$executeRawUnsafe(`ALTER TABLE "MemoryFact" ADD CONSTRAINT "memory207_test_rollback" CHECK ("id" <> '${old.id}'::uuid OR "supersededAt" IS NULL)`);
  try {
    await expect(store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact })).rejects.toThrow();
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
    expect(await store.recallMemory(botId, { query })).toContain("Ronaldo");
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "MemoryFact" DROP CONSTRAINT "memory207_test_rollback"');
  }
}));

dbTest("a correction refreshes the same-epoch prompt and excludes historical facts from future extraction", () => fixture(async ({ prisma, store, botId, root }) => {
  await store.initializeBot(botId);
  const context = await prisma.contextSession.create({ data: { botId, scope: "home", scopeId: botId } });
  const old = await write(store, botId);
  const prepare = async () => {
    const prompt = await store.promptContext(botId, context.id);
    const sections = await store.preparePlatformSections(botId, context.id, prompt.compactionEpoch, {}, prompt.memory);
    return sections.memory!.facts;
  };
  expect(await prepare()).toContain("Ronaldo");
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  expect(await prepare()).toContain("Messi");
  expect(await prepare()).not.toContain("Ronaldo");
  let extractionPrompt = "";
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async request => {
    extractionPrompt = request.prompt;
    return "NONE";
  } });
  await learner.recordTurnMemory(botId, { user: "What else should we remember about football?", assistant: "Nothing new." });
  expect(extractionPrompt).toContain("Messi");
  expect(extractionPrompt).not.toContain("Ronaldo");
}));

dbTest("a stale prompt preparation finishing after a correction cannot remain pinned on the next turn", () => fixture(async ({ prisma, store, botId }) => {
  await store.initializeBot(botId);
  const context = await prisma.contextSession.create({ data: { botId, scope: "home", scopeId: botId } });
  const old = await write(store, botId);
  const stale = await store.promptContext(botId, context.id);
  expect(stale.memory.facts).toContain("Ronaldo");
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  // Simulate the old preparation completing after the correction's invalidation.
  await store.preparePlatformSections(botId, context.id, stale.compactionEpoch, {}, stale.memory);
  const live = await store.promptContext(botId, context.id);
  const next = await store.preparePlatformSections(botId, context.id, live.compactionEpoch, {}, live.memory);
  expect(next.memory!.facts).toContain("Messi");
  expect(next.memory!.facts).not.toContain("Ronaldo");
}));

dbTest("legacy extraction cannot append a stale correction after a newer replacement wins", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = await write(store, botId);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `remove: ${oldFact}\nprofile: My favourite player is Neymar.`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: "My favourite player is Neymar now.", assistant: "Okay." });
  try {
    await started;
    await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  } finally { release(); await learning; }
  const current = await store.recallMemory(botId, { query });
  expect(current).toContain("Messi");
  expect(current).not.toContain("Neymar");
}));

dbTest("a mixed extraction response cannot resurrect the fact it just superseded", () => fixture(async ({ prisma, store, botId, root }) => {
  await write(store, botId);
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () =>
    `replace: ${JSON.stringify({ old: oldFact, fact: newFact })}\nprofile: ${oldFact}`,
  });
  await learner.recordTurnMemory(botId, { user: "My favourite football player is now Messi.", assistant: "Understood." });
  const current = await store.recallMemory(botId, { query });
  expect(current).toContain("Messi");
  expect(current).not.toContain("Ronaldo");
}));

dbTest("simultaneous shared corrections by separate assistants commit without deadlock or lost revisions", () => fixture(async ({ prisma, store, botId, peerId }) => {
  const initial = await Promise.all([botId, peerId].map(id => write(store, id, `Shared calibration for ${id} is red.`, "user")));
  const before = (await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
  await Promise.all([botId, peerId].map((id, index) => store.replaceMemory(id, {
    scope: "user", tier: "profile", id: initial[index]!.id!, fact: `Shared calibration for ${id} is blue.`,
  })));
  expect((await prisma.memoryRevision.findUniqueOrThrow({ where: { scope: "user" } })).revision).toBe(before + 2);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: { in: [botId, peerId] }, supersededAt: null } })).toBe(2);
  for (const id of [botId, peerId]) {
    const current = await store.recallMemory(id, { query: "Shared calibration" });
    expect(current.match(/is blue/g)).toHaveLength(2);
    expect(current).not.toContain("is red");
  }
}));

dbTest("a stale structured correction cannot sneak back in through a duplicate profile line", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = await write(store, botId);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const staleFact = "My favourite player is Neymar.";
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `replace: ${JSON.stringify({ old: oldFact, fact: staleFact })}\nprofile: ${staleFact}`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: "My favourite player is Neymar now.", assistant: "Okay." });
  try {
    await started;
    await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  } finally { release(); await learning; }
  const current = await store.recallMemory(botId, { query });
  expect(current).toContain("Messi");
  expect(current).not.toContain("Neymar");
}));

dbTest("contention on agent and shared facts produces exactly one winning correction", () => fixture(async ({ prisma, store, botId }) => {
  for (const scope of ["agent", "user"] as const) {
    for (let round = 0; round < 5; round++) {
      const old = await write(store, botId, `Contention ${scope} ${round} original.`, scope);
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.replaceMemory(botId, {
        scope, tier: "profile", id: old.id!, fact: `Contention ${scope} ${round} corrected to ${i}.`,
      })));
      const successes = results.filter(result => result.status === "fulfilled");
      expect(successes).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(11);
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: { startsWith: `Contention ${scope} ${round}` }, supersededAt: null } })).toBe(1);
    }
  }
}), 30_000);

dbTest("replacement retires all legacy duplicates and forget removes all matching historical versions", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const row = await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } });
  const { id: _id, ...duplicate } = row;
  await prisma.memoryFact.create({ data: { ...duplicate, tier: "log", sourceOrdinal: row.sourceOrdinal + 1 } });
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededById: current.id } })).toBe(2);
  expect(await store.recallMemory(botId, { query })).not.toContain("Ronaldo");
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: current.id, fact: oldFact });
  await store.forgetMemory(botId, { scope: "agent", fact: oldFact });
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: oldFact } })).toBe(0);
  expect(await store.recallMemory(botId, { query })).toContain("No facts");
  expect(await store.recallMemory(botId, { query, includeHistory: true })).toContain("Messi");
}));

dbTest("forgetting a shared fact refreshes the peer's prompt in the same epoch", () => fixture(async ({ prisma, store, botId, peerId }) => {
  await store.initializeBot(peerId);
  await write(store, botId, oldFact, "user");
  const context = await prisma.contextSession.create({ data: { botId: peerId, scope: "home", scopeId: peerId } });
  const prepare = async () => {
    const prompt = await store.promptContext(peerId, context.id);
    return (await store.preparePlatformSections(peerId, context.id, prompt.compactionEpoch, {}, prompt.memory)).memory!.facts;
  };
  expect(await prepare()).toContain("Ronaldo");
  await store.forgetMemory(botId, { scope: "user", fact: oldFact });
  expect(await prepare()).not.toContain("Ronaldo");
}));

dbTest("seeded correction histories preserve one active value without cycles or duplicate revisions on retries", () => fixture(async ({ prisma, store, botId }) => {
  let current = await write(store, botId, "Calibration preference is option 0.");
  let expectedContent = "Calibration preference is option 0.";
  let expectedVersions = 1;
  let seed = 207;
  for (let step = 0; step < 60; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const fact = `Calibration preference is option ${seed % 5}.`;
    const input = { scope: "agent" as const, tier: "profile" as const, id: current.id!, fact };
    const next = await store.replaceMemory(botId, input);
    expect(await store.replaceMemory(botId, input)).toEqual(next);
    if (fact !== expectedContent) expectedVersions++;
    expectedContent = fact;
    current = next;
    const rows = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
    expect(rows).toHaveLength(expectedVersions);
    expect(rows.filter(row => !row.supersededAt).map(row => row.fact)).toEqual([expectedContent]);
    for (const retired of rows.filter(row => row.supersededAt)) {
      const successor = rows.find(row => row.id === retired.supersededById)!;
      expect(successor).toBeDefined();
      expect(successor.sourceOrdinal).toBeGreaterThan(retired.sourceOrdinal);
    }
    expect((await store.listBotMemories(botId)).memories.map(row => row.content)).toEqual([expectedContent]);
  }
}), 30_000);

dbTest("an extraction based on an old revision cannot overwrite a later return to the identical text", () => fixture(async ({ prisma, store, botId, root }) => {
  const old = await write(store, botId);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const staleFact = "My favourite player is Neymar.";
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `replace: ${JSON.stringify({ old: oldFact, fact: staleFact })}`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: "My favourite player is Neymar now.", assistant: "Okay." });
  let restoredId = "";
  try {
    await started;
    const changed = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
    const restored = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: changed.id, fact: oldFact });
    restoredId = restored.id;
    expect(restoredId).not.toBe(old.id!);
  } finally { release(); await learning; }
  const current = await store.recallMemory(botId, { query });
  expect(current).toContain("Ronaldo");
  expect(current).toContain(`id: ${restoredId}; active`);
  expect(current).not.toContain("Neymar");
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(3);
}));

dbTest("failure while invalidating corrected memory rolls back facts, revisions and events together", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision;
  const eventCount = await prisma.event.count({ where: { topic: "memory.changed", entityId: botId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "Bot" ADD CONSTRAINT "memory207_test_revision_rollback" CHECK ("id" <> '${botId}'::uuid OR "memoryRevision" = ${revision})`);
  try {
    await expect(store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact })).rejects.toThrow();
    const facts = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
    expect(facts.map(fact => fact.fact)).toEqual([oldFact]);
    expect(facts[0]!.supersededAt).toBeNull();
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(revision);
    expect(await prisma.event.count({ where: { topic: "memory.changed", entityId: botId } })).toBe(eventCount);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Bot" DROP CONSTRAINT "memory207_test_revision_rollback"');
  }
}));

dbTest("a fresh process recalls the corrected value and retains explicitly labeled history", () => fixture(async ({ store, botId }) => {
  const old = await write(store, botId);
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  const script = `
    import { createPrismaClient } from ${JSON.stringify(join(import.meta.dir, "../../db/src/index.ts"))};
    import { AgentDataStore } from ${JSON.stringify(join(import.meta.dir, "../src/agent-data.ts"))};
    const prisma = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
    try {
      const store = new AgentDataStore(prisma);
      const input = { query: ${JSON.stringify(query)} };
      const current = await store.recallMemory(${JSON.stringify(botId)}, input);
      const history = await store.recallMemory(${JSON.stringify(botId)}, { ...input, includeHistory: true });
      console.log(JSON.stringify({ current, history }));
    } finally { await prisma.$disconnect(); }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.current).toContain("Messi");
  expect(result.current).not.toContain("Ronaldo");
  expect(result.history).toContain("Ronaldo");
  expect(result.history).toContain("superseded");
}));

dbTest("an addition-only extraction started before the first write cannot resurrect a subsequently corrected fact", () => fixture(async ({ prisma, store, botId, root }) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `profile: ${oldFact}`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: oldFact, assistant: "Remembered." });
  try {
    await started;
    const old = await write(store, botId);
    await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  } finally { release(); await learning; }
  const current = await store.recallMemory(botId, { query, limit: 1 });
  expect(current).toContain("Messi");
  expect(current).not.toContain("Ronaldo");
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
}));

dbTest("addition-only extraction cannot restore a fact removed while inference was running", () => fixture(async ({ prisma, store, botId, root }) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
    entered(); await blocked;
    return `profile: ${oldFact}`;
  } });
  const learning = learner.recordTurnMemory(botId, { user: oldFact, assistant: "Remembered." });
  try {
    await started;
    await write(store, botId);
    await store.forgetMemory(botId, { scope: "agent", fact: oldFact });
  } finally { release(); await learning; }
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
}));

dbTest("overlapping extraction sources and targets are rejected atomically in either order", () => fixture(async ({ prisma, store, botId, root }) => {
  for (const tier of ["profile", "log"] as const) {
    for (const reverse of [false, true]) {
      await store.deleteBotMemories(botId);
      const source = "Lives in Boston.";
      const intermediate = "Lives in Lisbon.";
      await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: source });
      await store.writeMemory(botId, { scope: "agent", tier, fact: intermediate });
      const lines = [
        `replace: ${JSON.stringify({ old: source, fact: intermediate })}`,
        `replace: ${JSON.stringify({ old: intermediate, fact: "Lives in Tokyo." })}`,
      ];
      if (reverse) lines.reverse();
      const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => lines.join("\n") });
      await learner.recordTurnMemory(botId, { user: "I changed where I live; please update my saved address.", assistant: "Understood." });
      const rows = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, orderBy: { sourceOrdinal: "asc" } });
      expect(rows.map(row => ({ fact: row.fact, tier: row.tier, retired: row.supersededAt }))).toEqual([
        { fact: source, tier: "profile", retired: null }, { fact: intermediate, tier, retired: null },
      ]);
    }
  }
}));

dbTest("a same-text correction cleans conflicting legacy tiers instead of returning unchanged", () => fixture(async ({ prisma, store, botId }) => {
  const fact = "Calibration mode is automatic.";
  const profile = await write(store, botId, fact);
  const row = await prisma.memoryFact.findUniqueOrThrow({ where: { id: profile.id } });
  const { id: _id, ...copy } = row;
  const journal = await prisma.memoryFact.create({ data: { ...copy, tier: "log", sourceOrdinal: row.sourceOrdinal + 1 } });
  const result = await store.replaceMemory(botId, { scope: "agent", tier: "log", id: journal.id, fact });
  expect(result.saved).toBe(true);
  const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null } });
  expect(active.map(row => ({ id: row.id, tier: row.tier }))).toEqual([{ id: result.id, tier: "log" }]);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, supersededById: result.id } })).toBe(2);
}));

dbTest("an extracted correction retains the exchange date instead of the replay time", () => fixture(async ({ prisma, store, botId, root }) => {
  await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: oldFact, at: new Date("2020-01-01") });
  const occurredAt = new Date("2024-07-09T12:34:56Z");
  const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () =>
    `replace: ${JSON.stringify({ old: oldFact, fact: newFact })}`,
  });
  await learner.recordTurnMemory(botId, { user: newFact, assistant: "Remembered.", occurredAt: occurredAt.getTime(), runId: "replayed-correction" });
  const current = await prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: botId, supersededAt: null } });
  expect(current.fact).toBe(newFact);
  expect(current.createdAt).toEqual(occurredAt);
  expect(current.origin).toBe("extract");
  expect(current.turnId).toBe("replayed-correction");
}));

dbTest("invalid model corrections cannot append contradictions or persist JSON fragments", () => fixture(async ({ prisma, store, botId, root }) => {
  const responses = [
    `replace: {\n  "old": ${JSON.stringify(oldFact)},\n  "fact": ${JSON.stringify(newFact)}\n}`,
    `replace: ${JSON.stringify({ old: oldFact.slice(0, -1), fact: newFact })}\nprofile: ${newFact}`,
    `remove: ${oldFact.slice(0, -1)}\nprofile: ${newFact}`,
  ];
  for (const response of responses) {
    await store.deleteBotMemories(botId);
    await write(store, botId);
    const learner = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => response });
    await learner.recordTurnMemory(botId, { user: newFact, assistant: "Remembered." });
    const rows = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
    expect(rows.map(row => ({ fact: row.fact, active: row.supersededAt === null }))).toEqual([{ fact: oldFact, active: true }]);
  }
}));

dbTest("identical text across private and shared shards stays isolated through correction and deletion", () => fixture(async ({ prisma, store, botId, peerId }) => {
  const privateFact = await write(store, botId);
  const ownShared = await write(store, botId, oldFact, "user");
  const peerShared = await write(store, peerId, oldFact, "user");
  const ownSharedBefore = await prisma.memoryFact.findUniqueOrThrow({ where: { id: ownShared.id } });
  const peerSharedBefore = await prisma.memoryFact.findUniqueOrThrow({ where: { id: peerShared.id } });
  const corrected = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: privateFact.id!, fact: newFact });
  const privateBefore = await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } });
  await store.forgetMemory(botId, { scope: "agent", fact: oldFact });
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: ownShared.id } })).toEqual(ownSharedBefore);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: peerShared.id } })).toEqual(peerSharedBefore);
  const sharedCorrection = await store.replaceMemory(botId, { scope: "user", tier: "profile", id: ownShared.id!, fact: "My favourite player is Neymar." });
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).toEqual(privateBefore);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: peerShared.id } })).toEqual(peerSharedBefore);
  await store.deleteBotMemories(botId);
  expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: sharedCorrection.id } })).supersededAt).toBeNull();
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: ownShared.id } })).supersededById).toBe(sharedCorrection.id);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: peerShared.id } })).toEqual(peerSharedBefore);
  expect(await store.recallMemory(peerId, { query, includeHistory: true })).not.toContain(newFact);
}));

dbTest("reusing a target older than its source preserves the target's original date and provenance", () => fixture(async ({ prisma, store, botId }) => {
  const target = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: newFact, at: new Date("2020-01-01") }, { source: "extract", turnId: "original-target-turn" });
  const source = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: oldFact, at: new Date("2024-01-01") }, { source: "tool", turnId: "source-turn" });
  const before = await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.id } });
  const request = { scope: "agent" as const, tier: "profile" as const, id: source.id!, fact: newFact };
  const result = await store.replaceMemory(botId, request, { source: "tool", turnId: "correction-turn" });
  expect(result.id).toBe(target.id!);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
  expect(await store.replaceMemory(botId, request)).toEqual(result);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: source.id } })).supersededById).toBe(target.id!);
  expect(await store.recallMemory(botId, { query })).not.toContain("Ronaldo");
}));

dbTest("shared recall preserves newest provenance while exposing an owned duplicate's editable id", () => fixture(async ({ prisma, store, botId, peerId }) => {
  const owned = await store.writeMemory(botId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2020-01-01") });
  const peer = await store.writeMemory(peerId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2026-01-01") });
  const result = await store.recallMemory(botId, { query, limit: 1 });
  expect(result).toContain("(2026-01-01)");
  expect(result).toContain(`id: ${peer.id}; active`);
  expect(result).toContain(`editable id: ${owned.id}`);
  const editableId = /editable id: ([a-f0-9-]{36})/.exec(result)![1]!;
  const corrected = await store.replaceMemory(botId, { scope: "user", tier: "profile", id: editableId, fact: newFact });
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: owned.id } })).supersededById).toBe(corrected.id);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: peer.id } })).supersededAt).toBeNull();
  const history = await store.recallMemory(botId, { query, includeHistory: true });
  expect(history).toContain(`id: ${owned.id}; superseded`);
  expect(history).toContain(`id: ${peer.id}; active`);
  expect(history.split("\n").find(line => line.includes(`id: ${owned.id}; superseded`))).not.toContain("editable id:");
  expect(history.split("\n").find(line => line.includes(`id: ${peer.id}; active`))).not.toContain("editable id:");
}));

dbTest("a failure after staging a target type change restores both original active facts", () => fixture(async ({ prisma, store, botId }) => {
  const targetText = "Calibration color is blue.";
  const old = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Calibration color is red." });
  const target = await store.writeMemory(botId, { scope: "agent", tier: "log", fact: targetText });
  await prisma.$executeRawUnsafe(`ALTER TABLE "MemoryFact" ADD CONSTRAINT "memory207_test_target_rollback" CHECK ("writtenByBotId" <> '${botId}'::uuid OR "fact" <> 'Calibration color is blue.' OR "tier"::text <> 'profile')`);
  try {
    await expect(store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: targetText })).rejects.toThrow();
    const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null } });
    expect(active.map(row => row.id).sort()).toEqual([old.id!, target.id!].sort());
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(0);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "MemoryFact" DROP CONSTRAINT "memory207_test_target_rollback"');
  }
}));

for (const action of ["write", "replace"] as const) {
  dbTest(`a blocked memory ${action} cannot commit after archival wins`, () => fixture(async ({ prisma, store, botId }) => {
    const old = action === "replace" ? await write(store, botId) : undefined;
    const memoryKey = `memory:agent:${botId}`;
    let entered!: () => void;
    let release!: () => void;
    const enteredLock = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const held = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryKey}))`;
      entered(); await released;
    }, { timeout: 15_000 });
    await enteredLock;
    const settled = <T>(promise: Promise<T>) => promise.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    const writing = settled(action === "write" ? write(store, botId, newFact) : store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old!.id!, fact: newFact }));
    let archiving: Promise<unknown> | undefined;
    const waiting = async (key: string) => (await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
      AND objid::bigint = (hashtext(${key})::bigint & 4294967295)
    `)[0]!.count > 0;
    try {
      let writerBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await waiting(memoryKey)) { writerBlocked = true; break; }
        await Bun.sleep(5);
      }
      expect(writerBlocked).toBe(true);
      archiving = prisma.$transaction(async tx => {
        await lockAgentLifecycle(tx, botId);
        await tx.bot.update({ where: { id: botId }, data: { status: "archived" } });
      });
      let reachedOrderingPoint = false;
      let archiveCommittedFirst = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        archiveCommittedFirst = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).status === "archived";
        if (archiveCommittedFirst || await waiting(`agent-lifecycle:${botId}`)) { reachedOrderingPoint = true; break; }
        await Bun.sleep(5);
      }
      expect(reachedOrderingPoint).toBe(true);
      release(); await held;
      const result = await writing;
      await archiving;
      // Either the writer held the lifecycle fence and committed first, or a
      // committed archive must make the delayed writer refuse new work.
      expect(result.status).toBe(archiveCommittedFirst ? "rejected" : "fulfilled");
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).status).toBe("archived");
    } finally {
      release(); await Promise.allSettled([held, writing, ...(archiving ? [archiving] : [])]);
    }
  }), 20_000);
}

for (const action of ["write", "replace"] as const) {
  dbTest(`memory ${action} refuses work when archival acquires the lifecycle fence first`, () => fixture(async ({ prisma, store, botId }) => {
    const old = action === "replace" ? await write(store, botId) : undefined;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const archiving = prisma.$transaction(async tx => {
      await lockAgentLifecycle(tx, botId.toUpperCase());
      await tx.bot.update({ where: { id: botId }, data: { status: "archived" } });
      entered(); await released;
    }, { timeout: 15_000 });
    await ready;
    const operation = action === "write" ? write(store, botId, newFact) : store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old!.id!, fact: newFact });
    const writing = operation.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    try {
      let blocked = false;
      const key = `agent-lifecycle:${botId}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
        if (locks[0]!.count > 0) { blocked = true; break; }
        await Bun.sleep(5);
      }
      expect(blocked).toBe(true);
      release(); await archiving;
      expect((await writing).status).toBe("rejected");
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: newFact } })).toBe(0);
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(0);
    } finally {
      release(); await Promise.allSettled([archiving, writing]);
    }
  }), 20_000);
}

dbTest("saved and corrected Unicode facts match their persisted text exactly", () => fixture(async ({ prisma, store, botId }) => {
  const inputs = ["x".repeat(499) + "😀", "name " + String.fromCharCode(0xd83d) + " here"];
  for (const fact of inputs) {
    await store.deleteBotMemories(botId);
    const saved = await write(store, botId, fact);
    expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: saved.id } })).fact).toBe(saved.content);
    const source = await write(store, botId, oldFact);
    const corrected = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: source.id!, fact });
    expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).fact).toBe(corrected.content);
  }
}));

dbTest("equivalent UUID casing addresses one private memory namespace and emits canonical identities", () => fixture(async ({ prisma, store, botId }) => {
  const upper = botId.toUpperCase();
  const saved = await write(store, upper, oldFact);
  const row = await prisma.memoryFact.findUniqueOrThrow({ where: { id: saved.id } });
  expect(row.namespace).toBe(`agent:${botId}`);
  expect(await store.recallMemory(botId, { query })).toContain("Ronaldo");
  expect((await store.listBotMemories(upper)).memories.map(row => row.content)).toEqual([oldFact]);
  const corrected = await store.replaceMemory(upper, { scope: "agent", tier: "profile", id: saved.id!, fact: newFact });
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).namespace).toBe(`agent:${botId}`);
  const events = await prisma.event.findMany({ where: { topic: "memory.changed", entityId: botId } });
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(event => event.entityId === botId && (event.payload as { botId: string }).botId === botId)).toBe(true);
  await store.deleteBotMemories(upper);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
}));

dbTest("UUID casing preserves editable shared aliases and exact-text forgetting", () => fixture(async ({ prisma, store, botId, peerId }) => {
  const owned = await store.writeMemory(botId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2020-01-01") });
  await store.writeMemory(peerId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2026-01-01") });
  expect(await store.recallMemory(botId.toUpperCase(), { query, limit: 1 })).toContain(`editable id: ${owned.id}`);
  await store.forgetMemory(botId.toUpperCase(), { scope: "user", fact: oldFact });
  expect(await prisma.memoryFact.findUnique({ where: { id: owned.id } })).toBeNull();
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: peerId, fact: oldFact } })).toBe(1);
}));

dbTest("racing exact-text deletion and correction never restores the deleted source revision", () => fixture(async ({ prisma, store, botId }) => {
  for (let round = 0; round < 20; round++) {
    await store.deleteBotMemories(botId);
    const old = await write(store, botId);
    const correction = () => store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
    const deletion = () => store.forgetMemory(botId, { scope: "agent", fact: oldFact });
    const operations = round % 2 ? [correction(), deletion()] : [deletion(), correction()];
    const results = await Promise.allSettled(operations);
    const correctionResult = results[round % 2 ? 0 : 1]!;
    const deletionResult = results[round % 2 ? 1 : 0]!;
    expect(deletionResult.status).toBe("fulfilled");
    const rows = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
    expect(rows.map(row => row.fact)).toEqual(correctionResult.status === "fulfilled" ? [newFact] : []);
    expect(rows.every(row => row.supersededAt === null)).toBe(true);
    await expect(correction()).rejects.toThrow("unavailable");
  }
}), 30_000);

dbTest("racing a full clear and a correction leaves no old or new private memory", () => fixture(async ({ prisma, store, botId }) => {
  for (let round = 0; round < 20; round++) {
    const old = await write(store, botId);
    await Promise.allSettled([
      store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact }),
      store.deleteBotMemories(botId),
    ]);
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
  }
}), 30_000);

dbTest("database-invalid replacement text cannot retire or alter the current fact", () => fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const before = await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } });
  await expect(store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: "invalid" + String.fromCharCode(0) + "text" })).rejects.toThrow();
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).toEqual(before);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
}));

dbTest("public memory operations reject noncanonical UUID spellings before creating split namespaces", () => fixture(async ({ prisma, store, botId }) => {
  for (const alias of [botId.replaceAll("-", ""), `{${botId}}`]) {
    await expect(write(store, alias)).rejects.toThrow("Bot not found");
    await expect(store.recallMemory(alias, { query })).rejects.toThrow("Bot not found");
    await expect(store.forgetMemory(alias, { scope: "agent", fact: oldFact })).rejects.toThrow("Bot not found");
  }
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(0);
}));
