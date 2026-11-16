// Memory corrections on PostgreSQL: supersession, recall, prompt invalidation and the
// fences that stop a delayed review from undoing a newer write.
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
type Fixture = { prisma: ReturnType<typeof createPrismaClient>; store: AgentDataStore; botId: string; peerId: string; root: string;
  learner(infer: (request: { prompt: string; instructions: string }) => Promise<string>): AgentDataStore };

function fixture(run: (f: Fixture) => Promise<void>) {
  return async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-corrections-"));
    const botId = crypto.randomUUID(), peerId = crypto.randomUUID();
    const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
    const learner: Fixture["learner"] = infer => new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: request => infer(request) });
    try {
      await prisma.bot.createMany({ data: [botId, peerId].map(id => ({ id, name: "Memory corrections", status: "active", defaultDirectory: root })) });
      await run({ prisma, store, botId, peerId, root, learner });
    } finally {
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
      await prisma.event.deleteMany({ where: { entityId: { in: [botId, peerId] } } });
      await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  };
}

const write = (store: AgentDataStore, botId: string, fact = oldFact, scope: "agent" | "user" = "agent", tier: "profile" | "log" = "profile") =>
  store.writeMemory(botId, { scope, tier, fact });
const revisionOf = async (prisma: Fixture["prisma"], botId: string) =>
  (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision +
  ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0);
const gate = () => Promise.withResolvers<void>();

dbTest("#207: a paraphrased correction excludes the more lexically relevant stale fact before ranking", fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  expect(await store.recallMemory(botId, { query })).toContain(`id: ${old.id}; active`);
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact }, { source: "tool", turnId: "correction-turn" });
  const result = await store.recallMemory(botId, { query, limit: 1 });
  expect(result).toContain("Messi");
  expect(result).not.toContain("Ronaldo");
  const history = await store.recallMemory(botId, { query, includeHistory: true });
  expect(history).toContain("Ronaldo");
  expect(history).toContain(`id: ${old.id}; superseded`);
  expect(history).toContain(`by ${current.id}`);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).supersededById).toBe(current.id);
  expect((await store.listBotMemories(botId)).memories.map(row => row.content)).toEqual([newFact]);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: current.id } })).turnId).toBe("correction-turn");
}));

dbTest("competing corrections of one fact in either scope leave exactly one winner", fixture(async ({ prisma, store, botId }) => {
  for (const scope of ["agent", "user"] as const) {
    const old = await write(store, botId, `Contention ${scope} original.`, scope);
    const inputs = [0, 1, 2].map(i => ({ scope, tier: "profile" as const, id: old.id!, fact: `Contention ${scope} corrected to ${i}.` }));
    const results = await Promise.allSettled(inputs.map(input => store.replaceMemory(botId, input)));
    const winners = results.flatMap((result, i) => result.status === "fulfilled" ? [{ value: result.value, input: inputs[i]! }] : []);
    expect(winners).toHaveLength(1);
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, scope, supersededAt: null }, select: { id: true } }))
      .toEqual([{ id: winners[0]!.value.id }]);
    expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, scope } })).toBe(2);
    // The winner's own retry is idempotent; the losers stay rejected.
    expect(await store.replaceMemory(botId, winners[0]!.input)).toEqual(winners[0]!.value);
  }
}));

dbTest("retries are idempotent without extra invalidations, and cannot resurrect a superseded result", fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId, "Preferred editor is Vim.");
  expect((await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: "Preferred editor is Vim." })).saved).toBe(false);
  const before = await revisionOf(prisma, botId);
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: "Preferred editor is Emacs." };
  const first = await store.replaceMemory(botId, input);
  const events = await prisma.event.count({ where: { entityId: botId, topic: "memory.changed" } });
  for (const retry of await Promise.all([0, 1, 2].map(() => store.replaceMemory(botId, input)))) expect(retry).toEqual(first);
  expect(await revisionOf(prisma, botId)).toBe(before + 1);
  expect(await prisma.event.count({ where: { entityId: botId, topic: "memory.changed" } })).toBe(events);
  // A changed type is a new request against an obsolete source, not a retry.
  await expect(store.replaceMemory(botId, { ...input, tier: "log" })).rejects.toThrow("superseded");
  await store.replaceMemory(botId, { ...input, id: first.id, fact: "Preferred editor is Zed." });
  await expect(store.replaceMemory(botId, input)).rejects.toThrow("superseded");
  expect((await store.listBotMemories(botId)).memories.map(row => row.content)).toEqual(["Preferred editor is Zed."]);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(3);
}));

dbTest("replacement enforces bot, scope and id ownership and canonical bot ids", fixture(async ({ prisma, store, botId, peerId }) => {
  const old = await write(store, botId.toUpperCase());
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: old.id } })).namespace).toBe(`agent:${botId}`);
  const input = { scope: "agent" as const, tier: "profile" as const, id: old.id!, fact: newFact };
  await expect(store.replaceMemory(peerId, input)).rejects.toThrow("unavailable");
  await expect(store.replaceMemory(botId, { ...input, scope: "user" })).rejects.toThrow("unavailable");
  await expect(store.replaceMemory(botId, { ...input, id: "not-an-id" })).rejects.toThrow("fact id");
  await expect(store.replaceMemory(botId, { ...input, fact: "   " })).rejects.toThrow("empty");
  await expect(store.replaceMemory(botId, { ...input, fact: "invalid" + String.fromCharCode(0) + "text" })).rejects.toThrow();
  for (const alias of [botId.replaceAll("-", ""), `{${botId}}`]) {
    await expect(write(store, alias)).rejects.toThrow("Bot not found");
    await expect(store.recallMemory(alias, { query })).rejects.toThrow("Bot not found");
  }
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true, supersededAt: true } }))
    .toEqual([{ fact: oldFact, supersededAt: null }]);
  const corrected = await store.replaceMemory(botId.toUpperCase(), input);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).namespace).toBe(`agent:${botId}`);
}));

dbTest("an identical target is reused in its type, retyped on request, and returning to an old value is a new revision", fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const existing = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: newFact, at: new Date("2020-01-01") });
  const existingRow = await prisma.memoryFact.findUniqueOrThrow({ where: { id: existing.id } });
  const current = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  expect(current.id).toBe(existing.id!);
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existingRow);
  const restored = await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: current.id, fact: oldFact });
  expect(restored.id).not.toBe(old.id!);
  // Same text, different type: the correction applies the requested type.
  const revision = await revisionOf(prisma, botId);
  const retyped = await store.replaceMemory(botId, { scope: "agent", tier: "log", id: restored.id, fact: oldFact });
  expect(retyped.saved).toBe(true);
  expect(await revisionOf(prisma, botId)).toBe(revision + 1);
  expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { id: true, tier: true } }))
    .toEqual([{ id: retyped.id, tier: "log" }]);
}));

dbTest("corrections and forgets invalidate pinned memory at once, including peers' shared snapshots", fixture(async ({ prisma, store, botId, peerId }) => {
  const pin = async () => {
    await prisma.contextSession.deleteMany({ where: { botId: { in: [botId, peerId] } } });
    for (const id of [botId, peerId]) await prisma.contextSession.create({ data: { botId: id, scope: "home", scopeId: id,
      promptSnapshot: { create: { promptSections: { memory: { render: "stale memory", compactionEpoch: 0 }, automations: { render: "keep", compactionEpoch: 0 } } } } } });
  };
  const pinned = async () => Object.fromEntries((await prisma.contextPromptSnapshot.findMany({
    where: { contextSession: { botId: { in: [botId, peerId] } } }, include: { contextSession: true },
  })).map(row => [row.contextSession.botId === botId ? "own" : "peer", "memory" in (row.promptSections as object)]));
  await pin();
  const own = await write(store, botId);
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: own.id!, fact: newFact });
  expect(await pinned()).toEqual({ own: false, peer: true });
  await pin();
  const shared = await write(store, botId, oldFact, "user");
  await store.replaceMemory(botId, { scope: "user", tier: "profile", id: shared.id!, fact: newFact });
  expect(await pinned()).toEqual({ own: false, peer: false });
  expect(await store.recallMemory(peerId, { query })).not.toContain("Ronaldo");
  await pin();
  await store.forgetMemory(botId, { scope: "user", fact: newFact });
  expect(await pinned()).toEqual({ own: false, peer: false });
  // Forgetting removes every version of the text, history included.
  await store.forgetMemory(botId, { scope: "agent", fact: oldFact });
  expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}`, fact: oldFact } })).toBe(0);
  expect(await store.recallMemory(botId, { query, includeHistory: true })).not.toContain(`[profile] ${oldFact}`);
}));

dbTest("a correction refreshes the same-epoch prompt even after a late stale preparation, and leaves history out of extraction", fixture(async ({ prisma, store, botId, learner }) => {
  await store.initializeBot(botId);
  const context = await prisma.contextSession.create({ data: { botId, scope: "home", scopeId: botId } });
  const old = await write(store, botId);
  const stale = await store.promptContext(botId, context.id);
  expect(stale.memory.facts).toContain("Ronaldo");
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
  // The old preparation finishes after the correction's invalidation.
  await store.preparePlatformSections(botId, context.id, stale.compactionEpoch, {}, stale.memory);
  const live = await store.promptContext(botId, context.id);
  expect(live.compactionEpoch).toBe(stale.compactionEpoch);
  const next = (await store.preparePlatformSections(botId, context.id, live.compactionEpoch, {}, live.memory)).memory!.facts;
  expect(next).toContain("Messi");
  expect(next).not.toContain("Ronaldo");
  let extractionPrompt = "";
  await learner(async request => { extractionPrompt = request.prompt; return "NONE"; })
    .recordTurnMemory(botId, { user: "What else should we remember about football?", assistant: "Nothing new." });
  expect(extractionPrompt).toContain("Messi");
  expect(extractionPrompt).not.toContain("Ronaldo");
}));

dbTest("extraction applies merges, retirements and additions in one batch, dated by the exchange, without resurrecting a source", fixture(async ({ prisma, store, botId, learner }) => {
  const previous = ["Lives in Boston.", "Works from Boston."];
  const removed = "The temporary office access code is 1234.";
  const current = "Lives and works in Lisbon.";
  for (const fact of [...previous, removed]) await store.writeMemory(botId, { scope: "agent", tier: "profile", fact, at: new Date("2020-01-01") });
  const occurredAt = new Date("2024-07-09T12:34:56Z");
  await learner(async request => {
    expect(request.instructions).toContain("Additional preferences are not replacements");
    for (const fact of [...previous, removed]) expect(request.prompt).toContain(fact);
    return [
      ...previous.map(old => `replace: ${JSON.stringify({ old, fact: current })}`),
      `remove: ${removed}`,
      "profile: Prefers afternoon meetings.",
      `profile: ${previous[0]}`,
    ].join("\n");
  }).recordTurnMemory(botId, { user: "I moved home and work to Lisbon; forget the old office code. I prefer afternoon meetings.",
    assistant: "Updated.", runId: "merged-extraction", occurredAt: occurredAt.getTime() });
  const active = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null } });
  expect(active.map(row => row.fact).sort()).toEqual([current, "Prefers afternoon meetings."].sort());
  const replacement = active.find(row => row.fact === current)!;
  expect(replacement).toMatchObject({ turnId: "merged-extraction", origin: "extract", createdAt: occurredAt });
  const history = await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: { not: null } } });
  expect(history.filter(row => previous.includes(row.fact)).map(row => row.supersededById)).toEqual([replacement.id, replacement.id]);
  expect(history.find(row => row.fact === removed)!.supersededById).toBeNull();
}));

dbTest("overlapping extraction sources and targets are rejected atomically in either order", fixture(async ({ prisma, store, botId, learner }) => {
  for (const reverse of [false, true]) {
    await store.deleteBotMemories(botId);
    await write(store, botId, "Lives in Boston.");
    await write(store, botId, "Lives in Lisbon.");
    const lines = [
      `replace: ${JSON.stringify({ old: "Lives in Boston.", fact: "Lives in Lisbon." })}`,
      `replace: ${JSON.stringify({ old: "Lives in Lisbon.", fact: "Lives in Tokyo." })}`,
    ];
    if (reverse) lines.reverse();
    await learner(async () => lines.join("\n")).recordTurnMemory(botId, { user: "I changed where I live; please update my saved address.", assistant: "Understood." });
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, orderBy: { sourceOrdinal: "asc" }, select: { fact: true, supersededAt: true } }))
      .toEqual([{ fact: "Lives in Boston.", supersededAt: null }, { fact: "Lives in Lisbon.", supersededAt: null }]);
  }
}));

for (const intervening of ["replace", "clear"] as const) {
  dbTest(`a review whose inference outlives a ${intervening} is discarded, even when it only adds facts`, fixture(async ({ prisma, store, botId, learner }) => {
    if (intervening === "clear") await write(store, botId);
    const entered = gate(), release = gate();
    const learning = learner(async () => { entered.resolve(); await release.promise; return `profile: ${oldFact}\nprofile: A stale review must not add this.`; })
      .recordTurnMemory(botId, { user: oldFact, assistant: "Remembered." });
    try {
      await entered.promise;
      if (intervening === "clear") await store.deleteBotMemories(botId);
      else await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: (await write(store, botId)).id!, fact: newFact });
    } finally { release.resolve(); }
    expect(await learning).toBe(true);
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { fact: true } }))
      .toEqual(intervening === "clear" ? [] : [{ fact: newFact }]);
  }));
}

dbTest("a failure while invalidating a correction rolls back facts, revisions and events together", fixture(async ({ prisma, store, botId }) => {
  const old = await write(store, botId);
  const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision;
  const events = await prisma.event.count({ where: { topic: "memory.changed", entityId: botId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "Bot" ADD CONSTRAINT "memory_test_revision_rollback" CHECK ("id" <> '${botId}'::uuid OR "memoryRevision" = ${revision})`);
  try {
    await expect(store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact })).rejects.toThrow();
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true, supersededAt: true } }))
      .toEqual([{ fact: oldFact, supersededAt: null }]);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(revision);
    expect(await prisma.event.count({ where: { topic: "memory.changed", entityId: botId } })).toBe(events);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Bot" DROP CONSTRAINT "memory_test_revision_rollback"');
  }
}));

dbTest("simultaneous shared corrections by separate assistants commit without deadlock or lost revisions", fixture(async ({ prisma, store, botId, peerId }) => {
  const tag = `SHARED${crypto.randomUUID().slice(0, 8)}`;
  const initial = await Promise.all([botId, peerId].map(id => write(store, id, `Shared calibration ${tag} for ${id} is red.`, "user")));
  const before = (await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0;
  await Promise.all([botId, peerId].map((id, index) => store.replaceMemory(id, {
    scope: "user", tier: "profile", id: initial[index]!.id!, fact: `Shared calibration ${tag} for ${id} is blue.`,
  })));
  expect((await prisma.memoryRevision.findUniqueOrThrow({ where: { scope: "user" } })).revision).toBe(before + 2);
  for (const id of [botId, peerId]) {
    const current = await store.recallMemory(id, { query: tag });
    expect(current.match(/is blue/g)).toHaveLength(2);
    expect(current).not.toContain("is red");
  }
}));

dbTest("identical text in private and shared shards stays isolated, and shared recall exposes the caller's editable id", fixture(async ({ prisma, store, botId, peerId }) => {
  const privateFact = await write(store, botId);
  const owned = await store.writeMemory(botId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2020-01-01") });
  const peer = await store.writeMemory(peerId, { scope: "user", tier: "profile", fact: oldFact, at: new Date("2026-01-01") });
  const peerBefore = await prisma.memoryFact.findUniqueOrThrow({ where: { id: peer.id } });
  await store.replaceMemory(botId, { scope: "agent", tier: "profile", id: privateFact.id!, fact: newFact });
  await store.forgetMemory(botId, { scope: "agent", fact: newFact });
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: owned.id } })).supersededAt).toBeNull();
  // The newest provenance is shown, with this bot's own duplicate as the editable id.
  const recalled = await store.recallMemory(botId, { query, limit: 1 });
  expect(recalled).toContain("(2026-01-01)");
  expect(recalled).toContain(`id: ${peer.id}; active`);
  const editableId = /editable id: ([a-f0-9-]{36})/.exec(recalled)?.[1];
  expect(editableId).toBe(owned.id!);
  const corrected = await store.replaceMemory(botId, { scope: "user", tier: "profile", id: editableId!, fact: newFact });
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: owned.id } })).supersededById).toBe(corrected.id);
  await store.deleteBotMemories(botId);
  expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
  expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: corrected.id } })).supersededAt).toBeNull();
  expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: peer.id } })).toEqual(peerBefore);
}));

dbTest("deletion or a full clear racing a correction never restores the old fact", fixture(async ({ prisma, store, botId }) => {
  for (const order of ["correction-first", "deletion-first"] as const) {
    await store.deleteBotMemories(botId);
    const old = await write(store, botId);
    const correction = () => store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: newFact });
    const deletion = () => store.forgetMemory(botId, { scope: "agent", fact: oldFact });
    const [first, second] = await Promise.allSettled(order === "correction-first" ? [correction(), deletion()] : [deletion(), correction()]);
    const corrected = order === "correction-first" ? first! : second!;
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, select: { fact: true, supersededAt: true } }))
      .toEqual(corrected.status === "fulfilled" ? [{ fact: newFact, supersededAt: null }] : []);
    await expect(correction()).rejects.toThrow("unavailable");
  }
  const old = await write(store, botId, "Cleared calibration fact.");
  await Promise.allSettled([
    store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old.id!, fact: "Corrected calibration fact." }),
    store.deleteBotMemories(botId),
  ]);
  expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: { contains: "calibration" } } })).toBe(0);
}));

for (const action of ["write", "replace"] as const) {
  dbTest(`a memory ${action} refuses work once archival holds the lifecycle fence`, fixture(async ({ prisma, store, botId }) => {
    const old = action === "replace" ? await write(store, botId) : undefined;
    const ready = gate(), release = gate();
    const archiving = prisma.$transaction(async tx => {
      await lockAgentLifecycle(tx, botId.toUpperCase());
      await tx.bot.update({ where: { id: botId }, data: { status: "archived" } });
      ready.resolve(); await release.promise;
    }, { timeout: 30_000 });
    await ready.promise;
    const writing = (action === "write" ? write(store, botId, newFact) : store.replaceMemory(botId, { scope: "agent", tier: "profile", id: old!.id!, fact: newFact }))
      .then(() => "fulfilled", () => "rejected");
    try {
      const key = `agent-lifecycle:${botId}`;
      let blocked = false;
      for (const deadline = Date.now() + 30_000; !blocked && Date.now() < deadline;) {
        blocked = (await prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${key})::bigint & 4294967295)`)[0]!.count > 0;
        if (!blocked) await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      release.resolve(); await archiving;
      expect(await writing).toBe("rejected");
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: newFact } })).toBe(0);
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(0);
    } finally {
      release.resolve(); await Promise.allSettled([archiving, writing]);
    }
  }));
}
