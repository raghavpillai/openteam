import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

for (const scope of ["agent", "user"] as const) {
  databaseTest(`a correction in ${scope} memory cancels an obsolete retry without losing the correction`, async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-retry-revision-"));
    let entered!: () => void;
    const firstAttempt = new Promise<void>((resolve) => { entered = resolve; });
    let attempts = 0;
    const data = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async () => {
      attempts++;
      if (attempts === 1) {
        entered();
        throw new Error("Synthetic malformed provider response");
      }
      return "profile: The synthetic calibration color is red.";
    } });
    const bot = await prisma.bot.create({ data: { name: "Retry correction fixture", status: "active", defaultDirectory: root } });
    let review: Promise<boolean> | undefined;
    try {
      const original = await data.writeMemory(bot.id, { scope, tier: "profile", fact: "The synthetic calibration color is red." });
      review = data.recordTurnMemory(bot.id, { user: "Remember the synthetic calibration color is red.", assistant: "Recorded red." });
      await firstAttempt;
      await data.replaceMemory(bot.id, { scope, tier: "profile", id: original.id!, fact: "The synthetic calibration color is blue." });
      expect(await review).toBe(true);
      expect(attempts).toBe(1);
      const facts = await prisma.memoryFact.findMany({ where: { writtenByBotId: bot.id } });
      expect(facts.filter((fact) => fact.supersededAt === null).map((fact) => fact.fact)).toEqual(["The synthetic calibration color is blue."]);
      expect(facts.find((fact) => fact.id === original.id)?.supersededAt).not.toBeNull();
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).pendingMemoryExchanges).toEqual([]);
      expect(await prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
    } finally {
      await review?.catch(() => {});
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: bot.id } });
      await prisma.bot.delete({ where: { id: bot.id } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}

databaseTest("an unchanged memory snapshot still retries a transient provider failure and publishes the result", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-retry-current-"));
  const prompts: string[] = [];
  const data = new AgentDataStore(prisma, { root, workspaceRoot: root, memoryInference: async (request) => {
    prompts.push(request.prompt);
    if (prompts.length === 1) throw new Error("Synthetic transient provider outage");
    return "profile: The synthetic calibration color is blue.";
  } });
  const bot = await prisma.bot.create({ data: { name: "Retry success fixture", status: "active", defaultDirectory: root } });
  try {
    expect(await data.recordTurnMemory(bot.id, { user: "Remember the synthetic calibration color is blue.", assistant: "Recorded blue." })).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(await prisma.memoryFact.findMany({ where: { writtenByBotId: bot.id, supersededAt: null }, select: { fact: true } }))
      .toEqual([{ fact: "The synthetic calibration color is blue." }]);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).pendingMemoryExchanges).toEqual([]);
    expect(await prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
  } finally {
    await prisma.memoryFact.deleteMany({ where: { writtenByBotId: bot.id } });
    await prisma.bot.delete({ where: { id: bot.id } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
