import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type PrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { BotService } from "../src/services/bot-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => Promise.withResolvers<void>();

test.skipIf(!databaseUrl)("shared memory correction and parent archival cannot deadlock on a child bot", async () => {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-archive-chaos-"));
  const parentId = crypto.randomUUID(), childId = crypto.randomUUID(), writerId = crypto.randomUUID();
  const ids = [parentId, childId, writerId];
  const childArchived = gate(), releaseArchive = gate();
  let archivePid = 0, correctionPid = 0;
  let archive: Promise<unknown> | undefined, correction: Promise<unknown> | undefined;
  let correctionSettled = false;
  const outcome = async (operation: string, work: Promise<unknown>) => {
    try { await work; return { operation, ok: true }; }
    catch (error) { return { operation, ok: false, error: String(error) }; }
  };
  try {
    // The original global Bot update scans the parent before the child. Keep
    // this insertion order so its real row locks invert archival's child-first order.
    for (const [index, id] of ids.entries()) {
      await db.bot.create({ data: {
        id, name: ["Archive parent", "Archive child", "Independent memory writer"][index]!,
        status: "active", defaultDirectory: root, conversation: { create: {} },
      } });
    }
    await db.subagent.create({ data: {
      parentBotId: parentId, childBotId: childId,
      parentRunId: crypto.randomUUID(), parentChannelId: crypto.randomUUID(),
      launchCallId: crypto.randomUUID(), description: "Finished child", prompt: "Finished child",
      subagentType: "generalPurpose", status: "completed", outputPath: join(root, "child.txt"),
    } });
    const data = new AgentDataStore(db, { root, workspaceRoot: root });
    const old = await data.writeMemory(writerId, { scope: "user", tier: "profile", fact: "Chaos calibration color is red." });

    const archiveDb = new Proxy(db, { get(owner, key) {
      if (key !== "$transaction") return Reflect.get(owner, key);
      return (work: any) => owner.$transaction(async (tx) => {
        archivePid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        return work(new Proxy(tx, { get(inner, prop) {
          if (prop !== "bot") return Reflect.get(inner, prop);
          return { ...inner.bot, updateMany: async (input: any) => {
            const result = await inner.bot.updateMany(input);
            if (input.data?.status === "archived" && input.where?.id?.in?.includes(childId)) {
              childArchived.resolve();
              await releaseArchive.promise;
            }
            return result;
          } };
        } }));
      }, { timeout: 15_000 });
    } }) as PrismaClient;
    const correctionDb = new Proxy(db, { get(owner, key) {
      if (key !== "$transaction") return Reflect.get(owner, key);
      return (work: any) => owner.$transaction(async (tx) => {
        correctionPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        return work(tx);
      }, { timeout: 15_000 });
    } }) as PrismaClient;
    const correctingData = new AgentDataStore(correctionDb, { root, workspaceRoot: root });
    const boss = { send: async () => null, sendDebounced: async () => null };
    const service = new BotService(archiveDb, boss as never, root, async () => Response.json({ ok: true }), data);
    archive = outcome("archive", Effect.runPromise(service.archive(parentId)));
    await Promise.race([
      childArchived.promise,
      archive.then(result => { throw new Error(`Archive ended before the child-lock barrier: ${JSON.stringify(result)}`); }),
    ]);
    correction = outcome("correction", correctingData.replaceMemory(writerId, {
      scope: "user", tier: "profile", id: old.id!, fact: "Chaos calibration color is blue.",
    })).finally(() => { correctionSettled = true; });

    // Wait for an actual database dependency, not a timing delay. An
    // invalidation that no longer touches unrelated bots may finish immediately.
    let blockedByArchive = false;
    const deadline = Date.now() + 5_000;
    while (!correctionSettled && Date.now() < deadline) {
      if (correctionPid) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${archivePid}::int = ANY(pg_blocking_pids(${correctionPid}::int)) AS blocked`;
        blockedByArchive = rows[0]!.blocked;
        if (blockedByArchive) break;
      }
      await Bun.sleep(5);
    }
    expect(blockedByArchive || correctionSettled).toBe(true);
    releaseArchive.resolve();
    const results = await Promise.all([archive, correction]);
    expect(results).toEqual([{ operation: "archive", ok: true }, { operation: "correction", ok: true }]);
    expect(await db.bot.count({ where: { id: { in: [parentId, childId] }, status: "archived" } })).toBe(2);
    const recalled = await data.recallMemory(writerId, { query: "Chaos calibration color" });
    expect(recalled).toContain("Chaos calibration color is blue.");
    expect(recalled).not.toContain("Chaos calibration color is red.");
  } finally {
    releaseArchive.resolve();
    await Promise.allSettled([archive, correction].filter(Boolean));
    await db.memoryFact.deleteMany({ where: { writtenByBotId: { in: ids } } });
    await db.bot.deleteMany({ where: { id: { in: ids } } });
    await db.retiredAgent.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
