import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../../src/agent-data";

const { botId, sourceId, fact, root } = JSON.parse(process.env.OPENTEAM_MEMORY_CRASH_FIXTURE!);
const prisma = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
const interrupted = new Proxy(prisma, {
  get(owner, key) {
    if (key === "$transaction") return (work: (tx: any) => Promise<unknown>) => owner.$transaction(async tx => {
      const result = await work(tx);
      // Real writes have completed, but PostgreSQL has not received COMMIT.
      console.log("MEMORY_MUTATION_BEFORE_COMMIT");
      await new Promise<void>(() => {});
      return result;
    }, { timeout: 30_000 });
    return Reflect.get(owner, key, owner);
  },
});
try {
  await new AgentDataStore(interrupted, { root, workspaceRoot: root }).replaceMemory(botId, { scope: "agent", tier: "profile", id: sourceId, fact });
} finally { await prisma.$disconnect(); }
