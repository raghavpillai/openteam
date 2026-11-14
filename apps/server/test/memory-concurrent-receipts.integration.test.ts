import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type PrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { DurableStateService } from "../src/update-state";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)("simultaneous identical memory tool calls do not expose database uniqueness failures", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "memory-concurrent-receipt-"));
  const botId = crypto.randomUUID(), callId = crypto.randomUUID();
  const contenders = 8;
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const wrapped = new Proxy(db, { get(owner, key) {
    if (key !== "idempotencyRecord") return Reflect.get(owner, key);
    return { ...owner.idempotencyRecord, findUnique: async (args: any) => {
      const result = await owner.idempotencyRecord.findUnique(args);
      if (args.where?.scope_key?.key === callId && result === null) {
        if (++reads === contenders) gate.resolve();
        await gate.promise;
      }
      return result;
    } };
  } }) as PrismaClient;
  try {
    await db.bot.create({ data: { id: botId, name: "Concurrent receipt fixture", status: "active", defaultDirectory: root } });
    const store = new AgentDataStore(wrapped, { root, workspaceRoot: root });
    await store.initializeBot(botId);
    const args = { action: "write", type: "profile", fact: "Prefers tea with breakfast." };
    const attempts = await Promise.allSettled(Array.from({ length: contenders }, () =>
      new DurableStateService(wrapped, {} as never, store, {} as never).executeTool(botId, callId, "UpdateMemory", args)));
    expect(reads).toBe(contenders);
    expect(await db.memoryFact.count({ where: { writtenByBotId: botId, supersededAt: null } })).toBe(1);
    const unexpected = attempts.flatMap(result => result.status === "rejected" && result.reason?.status !== 409
      ? [result.reason?.code ?? String(result.reason)] : []);
    expect(unexpected).toEqual([]);
    const record = await db.idempotencyRecord.findUniqueOrThrow({ where: { scope_key: { scope: `state:${botId}`, key: callId } } });
    expect(record.status).toBe("completed");
    const retry = await new DurableStateService(db, {} as never, store, {} as never).executeTool(botId, callId, "UpdateMemory", args);
    expect(retry as unknown).toEqual(record.response);
    expect(await db.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
  } finally {
    gate.resolve();
    await db.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
    await db.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
    await db.event.deleteMany({ where: { entityId: botId } });
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
