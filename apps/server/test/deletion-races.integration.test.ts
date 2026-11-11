import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { BotService } from "../src/services/bot-service";
import { GroupAdministration } from "../src/services/channel/group-administration";
import { WakeWorker } from "../../worker/src/worker";
import { dispatchComputerTurn } from "../../worker/src/runtime-dispatch";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const files = { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => null };

test.skipIf(!databaseUrl)('stale adoption snapshots must not recreate a group deleted by another worker', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Member', defaultDirectory: '/unused', status: 'active' } });
  const id = crypto.randomUUID(); const adoptionReached = gate(); const release = gate();
  let adoption: Promise<number> | undefined;
  try {
    const wrapped = new Proxy(p, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== '$executeRaw') return inner[prop];
        return async (strings: TemplateStringsArray, ...values: any[]) => {
          if (values[0] === `adopt-group:${id}`) { adoptionReached.resolve(); await release.promise; }
          return inner.$executeRaw(strings, ...values);
        };
      } })));
    } });
    const record = { id, kind: 'group', name: 'Delete me', description: '', title: '', createdAt: 1, updatedAt: 1, hasStore: true, notifyOnAgentUpdates: true, hiddenFromSidebar: false, memberIds: [bot.id] };
    const computer = async (_path: string, init: RequestInit) => init.method === 'GET' ? Response.json({ agents: [record] }) : Response.json({ ok: true });
    const worker = Object.assign(Object.create(WakeWorker.prototype), { prisma: wrapped, computerFetch: computer, workspaceRoot: '/unused', agentStoreEtag: null, pendingAgentStoreRecords: new Map() });
    adoption = worker.reconcileAgentStores(false);
    await adoptionReached.promise;
    // Another worker finishes adoption, then the owner deletes that newly visible group.
    await p.channel.create({ data: { id, kind: 'group', name: 'Delete me', members: { create: { botId: bot.id, ordinal: 0 } } } });
    const groups = new GroupAdministration(p, {} as any, '/unused', computer);
    await Effect.runPromise(groups.deleteGroup(id));
    release.resolve();
    const adopted = await adoption;
    const observed = { adopted, resurrected: !!await p.channel.findUnique({ where: { id } }) };
    expect(observed).toEqual({ adopted: 0, resurrected: false });
  } finally {
    release.resolve(); await adoption?.catch(() => {});
    await p.channel.deleteMany({ where: { id } }); await p.bot.delete({ where: { id: bot.id } }); await p.retiredAgent.deleteMany({ where: { id } }); await p.$disconnect();
  }
});

test.skipIf(!databaseUrl)('a delayed runtime acceptance must not start work after archive already returned', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Delayed dispatch', defaultDirectory: '/unused', status: 'active', conversation: { create: {} } }, include: { conversation: true } });
  const started = gate(); const accept = gate(); let active = false; let archiveDone = false;
  let dispatch: Promise<any> | undefined; let archive: Promise<any> | undefined;
  try {
    const run = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: 'running' } });
    dispatch = dispatchComputerTurn(p, run.id, async () => { started.resolve(); await accept.promise; active = true; return Response.json({ ok: true }); });
    await started.promise;
    const service = new BotService(p, {} as any, '/unused', async (path: string) => {
      if (path.endsWith('/cancel')) {
        if (!active) return new Response('Run is not actively executing', { status: 400 });
        active = false;
      }
      return Response.json({ ok: true });
    }, files as any);
    archive = Effect.runPromise(service.archive(bot.id)).then(() => { archiveDone = true; });
    let fenced = false; const deadline = Date.now() + 2_000;
    while (!archiveDone && !fenced && Date.now() < deadline) {
      const waiting = await p.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%Run%' AND query NOT LIKE '%pg_stat_activity%'`;
      fenced = waiting.length > 0;
      if (!fenced && !archiveDone) await new Promise(r => setTimeout(r, 2));
    }
    const returnedBeforeAcceptance = archiveDone;
    accept.resolve(); await dispatch; await archive;
    const observed = { returnedBeforeAcceptance, runtimeActive: active, fenced };
    expect(observed).toEqual({ returnedBeforeAcceptance: false, runtimeActive: false, fenced: true });
  } finally {
    accept.resolve(); await Promise.allSettled([dispatch, archive]);
    await p.bot.delete({ where: { id: bot.id } }); await p.retiredAgent.deleteMany({ where: { id: bot.id } }); await p.$disconnect();
  }
}, 15_000);

test.skipIf(!databaseUrl)('an expired dispatch releases cancellation and deletion can finish', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Expired dispatch', defaultDirectory: '/unused', status: 'active', conversation: { create: {} } }, include: { conversation: true } });
  const started = gate();
  let dispatch: Promise<unknown> | undefined;
  let archive: Promise<unknown> | undefined;
  try {
    const run = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: 'running' } });
    dispatch = dispatchComputerTurn(p, run.id, (signal) => new Promise<Response>((_resolve, reject) => {
      started.resolve();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 250).catch((error) => error);
    await started.promise;
    const service = new BotService(p, {} as any, '/unused', async (path) => path.endsWith('/cancel')
      ? new Response('Run is not actively executing', { status: 400 })
      : Response.json({ ok: true }), files as any);
    archive = Effect.runPromise(service.archive(bot.id));
    expect(String(await dispatch)).toContain('dispatch timed out');
    expect(await archive).toEqual({ ok: true });
    expect((await p.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('cancelled');
    expect(await p.retiredAgent.findUnique({ where: { id: bot.id } })).toMatchObject({ cleanupPending: false });
  } finally {
    await Promise.allSettled([dispatch, archive]);
    await p.bot.delete({ where: { id: bot.id } });
    await p.retiredAgent.deleteMany({ where: { id: bot.id } });
    await p.$disconnect();
  }
});


test.skipIf(!databaseUrl)('the adoption locks still allow an ordinary unknown group to be adopted once', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Member', defaultDirectory: '/unused', status: 'active' } });
  const id = crypto.randomUUID();
  try {
    const record = { id, kind: 'group', name: 'Import me', description: '', title: '', createdAt: 1, updatedAt: 1, hasStore: true, notifyOnAgentUpdates: true, hiddenFromSidebar: false, memberIds: [bot.id] };
    const worker = Object.assign(Object.create(WakeWorker.prototype), {
      prisma: p, workspaceRoot: '/unused', agentStoreEtag: null, pendingAgentStoreRecords: new Map(),
      computerFetch: async () => Response.json({ agents: [record] }),
    });
    expect(await worker.reconcileAgentStores(false)).toBe(1);
    expect(await worker.reconcileAgentStores(false)).toBe(0);
    expect(await p.channel.findUnique({ where: { id }, include: { members: true } })).toMatchObject({ name: 'Import me', members: [{ botId: bot.id }] });
  } finally {
    await p.channel.deleteMany({ where: { id } });
    await p.bot.delete({ where: { id: bot.id } });
    await p.$disconnect();
  }
});
