import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { memoryLogicalId } from "../src/memory-facts";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
for (const scope of ["agent", "user"] as const) test.skipIf(!databaseUrl)(
  `an ${scope} memory remains current and forgettable after 4,000 accumulated revisions`,
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-history-reliability-"));
    const botId = randomUUID(), contextId = randomUUID();
    const ids = Array.from({ length: 4_000 }, () => randomUUID());
    const namespace = scope === "agent" ? `agent:${botId}` : `user:agent:${botId}`;
    const store = new AgentDataStore(prisma, { root, workspaceRoot: root });
    const current = "Reliability calibration is currently violet.";
    try {
      await prisma.bot.create({ data: { id: botId, name: "Long-running memory", status: "active", defaultDirectory: root,
        contextSessions: { create: { id: contextId, scope: "home", scopeId: botId } },
      } });
      // Historical rows are fixture state, as if this assistant had been corrected
      // over several years. Actions below use the production store and queries.
      const data = ids.map((id, index) => {
        const fact = index === ids.length - 1 ? current : `Reliability calibration historical value ${index}.`;
        return { id, namespace, scope, tier: "profile" as const, fact, factHash: createHash("sha256").update(fact).digest("hex"),
          logicalId: memoryLogicalId(fact), sourceOrdinal: index, importance: 1, origin: "tool", writtenByBotId: botId,
          createdAt: new Date(Date.UTC(2010, 0, 1) + index * 86_400_000),
          ...(index === ids.length - 1 ? {} : { supersededAt: new Date("2025-01-01"), supersededById: ids[index + 1]! }),
        };
      });
      for (let offset = 0; offset < data.length; offset += 500) await prisma.memoryFact.createMany({ data: data.slice(offset, offset + 500) });
      const recall = await store.recallMemory(botId, { query: "Reliability calibration", limit: 1 });
      expect(recall).toContain(current);
      expect(recall).toContain("(1 fact searched)");
      expect(recall).not.toContain("historical value");
      const prompt = await store.promptContext(botId, contextId);
      expect(prompt.memory.facts).toContain(current);
      expect(prompt.memory.facts).not.toContain("historical value");
      if (scope === "agent") expect((await store.listBotMemories(botId)).total).toBe(1);
      const corrected = "Reliability calibration is currently orange.";
      const result = await store.replaceMemory(botId, { scope, tier: "profile", id: ids.at(-1)!, fact: corrected });
      expect(result.saved).toBe(true);
      expect(await prisma.memoryFact.count({ where: { namespace, supersededAt: null } })).toBe(1);
      expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: ids.at(-1)! } })).supersededById).toBe(result.id);
      expect(await store.recallMemory(botId, { query: "Reliability calibration", limit: 1 })).toContain(corrected);
      expect(await store.forgetMemory(botId, { scope, fact: corrected })).toHaveProperty("forgotten", true);
      expect(await store.recallMemory(botId, { query: "Reliability calibration" })).toContain("(0 searched)");
      const after = await store.promptContext(botId, contextId);
      expect(after.memory.facts).not.toContain("Reliability calibration");
      expect(await prisma.memoryFact.count({ where: { namespace } })).toBe(ids.length);
      if (scope === "agent") expect((await store.listBotMemories(botId)).total).toBe(0);
    } finally {
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000
);
