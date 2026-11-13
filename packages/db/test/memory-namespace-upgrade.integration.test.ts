import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";
import { createPrismaClient } from "../src/client";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
const deploy = async (url: string) => {
  const child = Bun.spawn([process.execPath, "scripts/deploy-schema.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status) throw new Error(`Schema deploy failed: ${stdout}\n${stderr}`);
};

for (const legacyColumns of [false, true]) {
dbTest(`namespace upgrade from ${legacyColumns ? "pre-versioned" : "current"} schema preserves aliases and is idempotent`, async () => {
  const admin = new Client({ connectionString: databaseUrl! });
  const name = `memory_namespace_${crypto.randomUUID().slice(0, 8)}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(databaseUrl!);
  target.pathname = `/${name}`;
  const prisma = createPrismaClient(target.toString());
  try {
    await deploy(target.toString());
    const botId = crypto.randomUUID();
    await prisma.bot.create({ data: { id: botId, name: "Namespace upgrade", defaultDirectory: "/tmp" } });
    const context = await prisma.contextSession.create({ data: { botId, scope: "home", scopeId: botId, promptSnapshot: { create: {
      profileSection: "keep profile", promptSections: { memory: { render: "stale", compactionEpoch: 0 }, automations: { render: "keep", compactionEpoch: 0 } },
    } } } });
    const legacy = [
      `agent:${botId.toUpperCase()}`, `agent:${botId}`, `user:agent:{${botId.toUpperCase()}}`,
      `user:agent:${botId.replaceAll("-", "")}`, `agent:not-a-uuid`, `project:${botId.toUpperCase()}`,
    ];
    const rows = [];
    for (const [i, namespace] of legacy.entries()) rows.push(await prisma.memoryFact.create({ data: {
      namespace, scope: namespace.startsWith("user:") ? "user" : "agent", fact: `Preserved fact ${i}`, factHash: `hash${i}`,
      logicalId: i < 2 ? "0000000000000000" : i.toString(16).padStart(16, "0"), sourceOrdinal: i, writtenByBotId: botId,
      origin: "extract", turnId: `turn-${i}`, supersededAt: i === 1 && !legacyColumns ? new Date("2024-01-01") : null,
      supersededById: i === 1 && !legacyColumns ? crypto.randomUUID() : null,
    } }));
    if (legacyColumns) {
      await prisma.$executeRawUnsafe('DROP TABLE "MemoryRevision"');
      await prisma.$executeRawUnsafe('ALTER TABLE "Bot" DROP COLUMN "memoryRevision"');
      await prisma.$executeRawUnsafe('ALTER TABLE "MemoryFact" DROP COLUMN "supersededAt", DROP COLUMN "supersededById"');
      await prisma.$executeRawUnsafe('ALTER TABLE "ContextPromptSnapshot" DROP COLUMN "promptSections"');
    }
    await deploy(target.toString());
    for (const [i, before] of rows.entries()) {
      const namespace = i < 2 ? `agent:${botId}` : i < 4 ? `user:agent:${botId}` : legacy[i]!;
      expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: before.id } })).toEqual({ ...before, namespace });
    }
    const snapshot = await prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: context.id } });
    expect(snapshot.promptSections).not.toHaveProperty("memory");
    if (legacyColumns) expect(snapshot.promptSections).toEqual({});
    else expect(snapshot.promptSections).toHaveProperty("automations");
    expect(snapshot.profileSection).toBe("keep profile");
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision + ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0)).toBe(legacyColumns ? 0 : 1);
    await deploy(target.toString());
    expect(await prisma.memoryFact.count()).toBe(rows.length);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision + ((await prisma.memoryRevision.findUnique({ where: { scope: "user" } }))?.revision ?? 0)).toBe(legacyColumns ? 0 : 1);
  } finally {
    await prisma.$disconnect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 30_000);
}
