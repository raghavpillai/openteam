import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { BotService } from "../src/services/bot-service";
import { WakeWorker } from "../../worker/src/worker";
import { dispatchComputerTurn } from "../../worker/src/runtime-dispatch";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
};

test.skipIf(!databaseUrl)("parent deletion fences a child claim that already selected its queued turn", async () => {
  const p = createPrismaClient(databaseUrl!);
  const bots: string[] = [];
  const selected = gate(), release = gate(), archiveReached = gate();
  let claim: Promise<any> | undefined;
  let archive: Promise<any> | undefined;
  let archiveDone = false;
  try {
    const runs = [];
    for (const name of ["Parent", "Child"]) {
      const bot = await p.bot.create({ data: { name, defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
      bots.push(bot.id);
      runs.push(await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "queued" } }));
    }
    const childRun = runs[1]!;
    await p.subagent.create({ data: {
      parentBotId: bots[0]!, childBotId: bots[1]!, parentRunId: runs[0]!.id,
      parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(),
      description: "Child", prompt: "Work", subagentType: "executor", status: "queued",
      currentRunId: childRun.id, outputPath: "/unused/child-output.jsonl",
    } });
    await p.inboxEvent.create({ data: {
      botId: bots[1]!, conversationId: childRun.conversationId, runId: childRun.id,
      idempotencyKey: crypto.randomUUID(), type: "subagent.task",
      payload: { content: "Work", clientId: crypto.randomUUID() },
    } });
    const claimDb = new Proxy(p, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "inboxEvent") return inner[prop];
        return { ...inner.inboxEvent, findMany: async (input: any) => {
          const snapshot = await inner.inboxEvent.findMany(input);
          selected.resolve(); await release.promise; return snapshot;
        } };
      } })), { timeout: 10_000 });
    } });
    const worker = Object.assign(Object.create(WakeWorker.prototype), { prisma: claimDb, workspaceRoot: "/unused", messaging: { assets: { runtimeImages: async () => [] } } });
    claim = worker.claim(bots[1]!);
    await selected.promise;
    const archiveDb = new Proxy(p, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "$executeRaw") return inner[prop];
        return async (strings: TemplateStringsArray, ...values: any[]) => {
          if (values[0] === `bot-run-claim:${bots[1]}`) archiveReached.resolve();
          return inner.$executeRaw(strings, ...values);
        };
      } })), { timeout: 10_000 });
    } });
    const service = new BotService(archiveDb, {} as never, "/unused", async () => Response.json({ ok: true }), {
      deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => null,
    } as never);
    archive = Effect.runPromise(service.archive(bots[0]!)).then((value) => {
      archiveDone = true; archiveReached.resolve(); return value;
    });
    await archiveReached.promise;
    const returnedBeforeClaimSettled = archiveDone;
    release.resolve();
    await claim; await archive;
    let sends = 0;
    const dispatch = await dispatchComputerTurn(p, childRun.id, async () => { sends++; return Response.json({ ok: true }); }).catch(String);
    expect({
      returnedBeforeClaimSettled,
      status: (await p.run.findUniqueOrThrow({ where: { id: childRun.id } })).status,
      contexts: await p.contextSession.count({ where: { botId: bots[1] } }),
      sends,
      invalidated: String(dispatch).includes("invalidated"),
    }).toEqual({ returnedBeforeClaimSettled: false, status: "cancelled", contexts: 0, sends: 0, invalidated: true });
  } finally {
    release.resolve(); await Promise.allSettled([claim, archive]);
    await p.bot.deleteMany({ where: { id: { in: bots } } });
    await p.retiredAgent.deleteMany({ where: { id: { in: bots } } });
    await p.$disconnect();
  }
}, 20_000);
