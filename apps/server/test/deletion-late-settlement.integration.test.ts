import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { BotService } from "../src/services/bot-service";
import { Projection } from "../../worker/src/projection";
import { WakeWorker } from "../../worker/src/worker";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => Promise.withResolvers<void>();
const files = { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => null };

for (const kind of ["completion", "failure"] as const) {
  test.skipIf(!url)(`a late ${kind} cannot overwrite deletion after reading a running turn`, async () => {
    const db = createPrismaClient(url!);
    const bot = await db.bot.create({ data: { name: "Late settlement", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
    const run = await db.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
    const inbox = await db.inboxEvent.create({ data: { botId: bot.id, conversationId: run.conversationId, runId: run.id, idempotencyKey: crypto.randomUUID(), type: "user.message", status: "processing", payload: {} } });
    const read = gate(), release = gate();
    let settlement: Promise<unknown> | undefined, archive: Promise<unknown> | undefined;
    try {
      const wrapped = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
          if (prop !== "run") return inner[prop];
          const method = kind === "completion" ? "findUniqueOrThrow" : "findUnique";
          return { ...inner.run, [method]: async (input: any) => {
            const snapshot = await inner.run[method](input);
            read.resolve(); await release.promise; return snapshot;
          } };
        } })), { timeout: 10_000 });
      } });
      if (kind === "completion") {
        settlement = new Projection(wrapped).apply(run.id, run.conversationId, bot.id, { type: "turn.completed", status: "completed" } as never);
      } else {
        const worker = Object.assign(Object.create(WakeWorker.prototype), {
          prisma: wrapped, messaging: { scheduleTranscriptProjection: async () => {} },
          routines: { afterExecution: async () => {} },
        });
        settlement = worker.fail({ runId: run.id, botId: bot.id, inboxId: inbox.id, origin: "user", ownerId: "fixture" }, new Error("late disconnect"), true);
      }
      await read.promise;
      let archived = false;
      const service = new BotService(db, {} as never, "/unused", async () => Response.json({ ok: true }), files as never);
      archive = Effect.runPromise(service.archive(bot.id)).then(() => { archived = true; });
      // Before the fix deletion commits here. With serialization it waits on the settlement's
      // run row, which must finish before deletion can persist its authoritative cancellation.
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!archived && !waiting && Date.now() < deadline) {
        const rows = await db.$queryRaw<any[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%Run%' AND query NOT LIKE '%pg_stat_activity%'`;
        waiting = rows.length > 0;
        if (!waiting && !archived) await Bun.sleep(2);
      }
      const archivedBeforeSettlement = archived;
      release.resolve(); await settlement; await archive;
      const final = await db.run.findUniqueOrThrow({ where: { id: run.id } });
      // Completion that wins first is retained as completed history. A failure that wins first
      // is interrupted history. Neither may commit a new terminal state after deletion commits.
      expect({ archivedBeforeSettlement, status: final.status, code: (final.error as any)?.code }).toEqual({
        archivedBeforeSettlement: false, status: kind === "completion" ? "completed" : "interrupted",
        code: kind === "completion" ? undefined : "runtime_interrupted",
      });
    } finally {
      release.resolve(); await Promise.allSettled([settlement, archive]);
      await db.bot.delete({ where: { id: bot.id } });
      await db.retiredAgent.deleteMany({ where: { id: bot.id } });
      await db.$disconnect();
    }
  }, 15_000);
}

test.skipIf(!url)("a buffered completion preserves the deletion reason after cancellation committed", async () => {
  const db = createPrismaClient(url!);
  const bot = await db.bot.create({ data: { name: "Buffered completion", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
  try {
    const run = await db.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
    const service = new BotService(db, {} as never, "/unused", async () => Response.json({ ok: true }), files as never);
    await Effect.runPromise(service.archive(bot.id));
    await new Projection(db).apply(run.id, run.conversationId, bot.id, {
      type: "turn.completed", status: "cancelled", error: { code: "runtime_cancelled", message: "Runtime stopped" },
    } as never);
    expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled", error: { code: "bot_archived" } });
  } finally {
    await db.bot.delete({ where: { id: bot.id } });
    await db.retiredAgent.deleteMany({ where: { id: bot.id } });
    await db.$disconnect();
  }
});

test.skipIf(!url)("parent deletion and a child's failure settle without a run/subagent deadlock", async () => {
  const db = createPrismaClient(url!);
  const bots: string[] = [];
  const read = gate(), release = gate();
  let failure: Promise<any> | undefined, archive: Promise<any> | undefined;
  try {
    const runs = [];
    for (const name of ["Parent", "Failing child"]) {
      const bot = await db.bot.create({ data: { name, defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
      bots.push(bot.id);
      runs.push(await db.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } }));
    }
    const childRun = runs[1]!;
    const sub = await db.subagent.create({ data: {
      parentBotId: bots[0]!, childBotId: bots[1]!, parentRunId: runs[0]!.id,
      parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(),
      description: "Child", prompt: "Work", subagentType: "executor", status: "running",
      currentRunId: childRun.id, outputPath: "/unused/child-output.jsonl",
    } });
    await db.subagentAttempt.create({ data: {
      subagentId: sub.id, parentRunId: sub.parentRunId, parentChannelId: sub.parentChannelId,
      parentToolCallId: sub.launchCallId, childRunId: childRun.id,
      description: sub.description, prompt: sub.prompt, status: "running",
    } });
    const inbox = await db.inboxEvent.create({ data: { botId: bots[1]!, conversationId: childRun.conversationId, runId: childRun.id, idempotencyKey: crypto.randomUUID(), type: "subagent.task", status: "processing", payload: {} } });
    const wrapped = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "run") return inner[prop];
        return { ...inner.run, update: async (input: any) => {
          const result = await inner.run.update(input);
          read.resolve(); await release.promise; return result;
        } };
      } })), { timeout: 10_000 });
    } });
    const worker = Object.assign(Object.create(WakeWorker.prototype), {
      prisma: wrapped, messaging: { scheduleTranscriptProjection: async () => {} },
      routines: { afterExecution: async () => {} }, notifySubagentParent: async () => {},
    });
    failure = worker.fail({ runId: childRun.id, botId: bots[1]!, inboxId: inbox.id, origin: "subagent", ownerId: "fixture" }, new Error("late disconnect"), true)
      .then(() => ({}), (error: unknown) => ({ error: String(error) }));
    await read.promise;
    const service = new BotService(db, {} as never, "/unused", async () => Response.json({ ok: true }), files as never);
    archive = Effect.runPromise(service.archive(bots[0]!)).then(() => ({}), (error) => ({ error: String(error) }));
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (!waiting && Date.now() < deadline) {
      const rows = await db.$queryRaw<any[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%Run%' AND query NOT LIKE '%pg_stat_activity%'`;
      waiting = rows.length > 0;
      if (!waiting) await Bun.sleep(2);
    }
    release.resolve();
    const result = await Promise.all([failure, archive]);
    expect(result).toEqual([{}, {}]);
    expect(waiting).toBe(true);
    expect(await db.bot.count({ where: { id: { in: bots }, status: "archived" } })).toBe(2);
    expect(await db.run.count({ where: { botId: { in: bots }, status: { in: ["queued", "running"] } } })).toBe(0);
  } finally {
    release.resolve(); await Promise.allSettled([failure, archive]);
    await db.bot.deleteMany({ where: { id: { in: bots } } });
    await db.retiredAgent.deleteMany({ where: { id: { in: bots } } });
    await db.$disconnect();
  }
}, 15_000);
