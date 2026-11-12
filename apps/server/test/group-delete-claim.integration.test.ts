import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { GroupAdministration } from "../src/services/channel/group-administration";
import { WakeWorker } from "../../worker/src/worker";
import { dispatchComputerTurn } from "../../worker/src/runtime-dispatch";
import { NativeToolExecutor } from "../../computer/src/native-tool-executor";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test.skipIf(!databaseUrl)('a stale queued claim exits cleanly when room deletion commits first', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Member', defaultDirectory: '/unused', status: 'active', conversation: { create: {} } }, include: { conversation: true } });
  const room = await p.channel.create({ data: { kind: 'group', name: 'Delete', members: { create: { botId: bot.id, ordinal: 0 } } } });
  const selected = gate(), release = gate();
  let claim: Promise<any> | undefined;
  try {
    const root = await p.channelMessage.create({ data: { channelId: room.id, sender: 'user', content: 'Work' } });
    const round = await p.channelRound.create({ data: { channelId: room.id, triggerMessageId: root.id, rootMessageId: root.id, deliveries: { create: { botId: bot.id, ordinal: 0, status: 'queued' } } }, include: { deliveries: true } });
    const run = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), channelId: room.id, deliveryId: round.deliveries[0]!.id, status: 'queued' } });
    await p.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, runId: run.id, idempotencyKey: crypto.randomUUID(), type: 'channel.message', payload: { content: 'Work', clientId: crypto.randomUUID() } } });
    const wrapped = new Proxy(p, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, property) {
        if (property !== 'inboxEvent') return inner[property];
        return { ...inner.inboxEvent, findMany: async (input: any) => {
          const snapshot = await inner.inboxEvent.findMany(input);
          selected.resolve(); await release.promise; return snapshot;
        } };
      } })));
    } });
    const worker = Object.assign(Object.create(WakeWorker.prototype), { prisma: wrapped, workspaceRoot: '/unused', messaging: { assets: { runtimeImages: async () => [] } } });
    claim = worker.claim(bot.id);
    await selected.promise;
    const groups = new GroupAdministration(p, {} as never, '/unused', async () => Response.json({ ok: true }));
    await Effect.runPromise(groups.deleteGroup(room.id));
    release.resolve();
    expect(await claim).toBeNull();
    expect(await p.botRunLease.count({ where: { botId: bot.id } })).toBe(0);
    expect(await p.contextSession.count({ where: { scope: 'channel', scopeId: room.id } })).toBe(0);
  } finally {
    release.resolve(); await claim?.catch(() => {});
    await p.channel.deleteMany({ where: { id: room.id } }); await p.bot.delete({ where: { id: bot.id } }); await p.retiredAgent.deleteMany({ where: { id: room.id } }); await p.$disconnect();
  }
});

test.skipIf(!databaseUrl)('group deletion must serialize with a worker claim before touching run and inbox rows', async () => {
  const p = createPrismaClient(databaseUrl!);
  const bot = await p.bot.create({ data: { name: 'Claim fixture', defaultDirectory: '/unused', status: 'active', conversation: { create: {} } }, include: { conversation: true } });
  const channel = await p.channel.create({ data: { kind: 'group', name: 'Delete me', members: { create: { botId: bot.id, ordinal: 0 } } } });
  const beforeRunWrite = gate(); const releaseClaim = gate(); const deleteContended = gate();
  let claim: Promise<any> | undefined; let deletion: Promise<any> | undefined;
  try {
    const root = await p.channelMessage.create({ data: { channelId: channel.id, sender: 'user', content: 'Work' } });
    const round = await p.channelRound.create({ data: { channelId: channel.id, triggerMessageId: root.id, rootMessageId: root.id, deliveries: { create: { botId: bot.id, ordinal: 0, status: 'queued' } } }, include: { deliveries: true } });
    const run = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), channelId: channel.id, deliveryId: round.deliveries[0]!.id, status: 'queued' } });
    await p.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, runId: run.id, idempotencyKey: crypto.randomUUID(), type: 'channel.message', payload: { content: 'Work', clientId: crypto.randomUUID() } } });
    const claimDb = new Proxy(p, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== 'run') return inner[prop];
        return { ...inner.run, update: async (input: any) => {
          if (input.data.status === 'running') { beforeRunWrite.resolve(); await releaseClaim.promise; }
          return inner.run.update(input);
        } };
      } })), { timeout: 10_000 });
    } });
    const worker = Object.assign(Object.create(WakeWorker.prototype), { prisma: claimDb, workspaceRoot: '/unused', messaging: { assets: { runtimeImages: async () => [] } } });
    claim = worker.claim(bot.id).then((value: any) => ({ value }), (error: any) => ({ error: String(error) }));
    await beforeRunWrite.promise;
    const deleteDb = new Proxy(p, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop === '$executeRaw') return async (strings: TemplateStringsArray, ...values: any[]) => {
          if (values[0] === `group-execution:${channel.id}`) deleteContended.resolve();
          return inner.$executeRaw(strings, ...values);
        };
        if (prop !== 'run') return inner[prop];
        return { ...inner.run, updateMany: async (input: any) => {
          const result = await inner.run.updateMany(input);
          deleteContended.resolve();
          return result;
        } };
      } })), { timeout: 10_000 });
    } });
    const groups = new GroupAdministration(deleteDb, {} as any, '/unused', async () => Response.json({ ok: true }));
    deletion = Effect.runPromise(groups.deleteGroup(channel.id)).then((value: any) => ({ value }), (error: any) => ({ error: String(error) }));
    await deleteContended.promise;
    releaseClaim.resolve();
    const [claimed, deleted] = await Promise.all([claim, deletion]);
    expect(claimed.error).toBeUndefined();
    expect(deleted.error).toBeUndefined();
    expect(await p.channel.findUnique({ where: { id: channel.id } })).toBeNull();
    expect((await p.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('cancelled');
    let sends = 0;
    await expect(dispatchComputerTurn(p, run.id, async () => { sends++; return Response.json({ ok: true }); })).rejects.toThrow("invalidated");
    expect(sends).toBe(0);
  } finally {
    releaseClaim.resolve(); await Promise.allSettled([claim, deletion]);
    await p.channel.deleteMany({ where: { id: channel.id } }); await p.bot.delete({ where: { id: bot.id } }); await p.retiredAgent.deleteMany({ where: { id: channel.id } }); await p.$disconnect();
  }
}, 20_000);


for (const status of ["queued", "running", "completed"] as const) {
  test.skipIf(!databaseUrl)(`deleting a room with a ${status} delivery retains history and leaves unrelated runs alone`, async () => {
    const p = createPrismaClient(databaseUrl!);
    const bot = await p.bot.create({ data: { name: "Member", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
    const room = await p.channel.create({ data: { kind: "group", name: "Delete", members: { create: { botId: bot.id, ordinal: 0 } } } });
    try {
      const root = await p.channelMessage.create({ data: { channelId: room.id, sender: "user", content: "Work" } });
      const round = await p.channelRound.create({ data: {
        channelId: room.id, triggerMessageId: root.id, rootMessageId: root.id,
        deliveries: { create: { botId: bot.id, ordinal: 0, status: status === "running" ? "processing" : status } },
      }, include: { deliveries: true } });
      const run = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), channelId: room.id, deliveryId: round.deliveries[0]!.id, status } });
      const unrelated = await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
      const groups = new GroupAdministration(p, {} as never, "/unused", async () => Response.json({ ok: true }));
      expect(await Effect.runPromise(groups.deleteGroup(room.id))).toEqual({ deleted: true, channelId: room.id });
      expect(await p.run.findUnique({ where: { id: run.id } })).toMatchObject({
        channelId: null, deliveryId: null, status: status === "completed" ? "completed" : "cancelled",
      });
      expect(await p.run.findUnique({ where: { id: unrelated.id } })).toMatchObject({ status: "running" });
      expect(await p.channelRound.count({ where: { channelId: room.id } })).toBe(0);
    } finally {
      await p.channel.deleteMany({ where: { id: room.id } }).catch(() => {});
      await p.bot.delete({ where: { id: bot.id } });
      await p.channel.deleteMany({ where: { id: room.id } });
      await p.retiredAgent.deleteMany({ where: { id: room.id } });
      await p.$disconnect();
    }
  });
}


test.skipIf(!databaseUrl || process.platform === "win32")("room deletion stops completed turns' background commands without stopping another room", async () => {
  const p = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "openteam-group-shell-delete-"));
  await chmod(root, 0o755);
  const executor = new NativeToolExecutor({ agentDir: root, controlToken: "fixture" });
  const bot = await p.bot.create({ data: { name: "Member", defaultDirectory: root, status: "active", conversation: { create: {} } }, include: { conversation: true } });
  const rooms: string[] = [];
  const jobs: Array<{ id: string; room: string }> = [];
  const status = async (id: string, wait = 0) => (await executor.awaitShell({ shell_id: id, block_until_ms: wait }, undefined, bot.id)).details.status;
  try {
    for (let i = 0; i < 2; i++) {
      const room = await p.channel.create({ data: { kind: "group", name: `Room ${i}`, members: { create: { botId: bot.id, ordinal: 0 } } } });
      rooms.push(room.id);
      await p.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), channelId: room.id, status: "completed" } });
      const result = await executor.shell({ command: "sleep 20", block_until_ms: 0 }, root, undefined, undefined, bot.id, { channelId: room.id });
      jobs.push({ id: String(result.details?.shellId), room: room.id });
    }
    const groups = new GroupAdministration(p, {} as never, root, async (path) => {
      const match = path.match(/^\/v1\/bots\/([^/]+)\/background-shells\/stop$/);
      return Response.json({ ok: true, ...(match ? { stopped: executor.stopBackgroundShells(decodeURIComponent(match[1]!)) } : {}) });
    });
    expect(await Effect.runPromise(groups.deleteGroup(rooms[0]!))).toEqual({ deleted: true, channelId: rooms[0]! });
    expect(await status(jobs[0]!.id, 3000)).toBe("completed");
    expect(await status(jobs[1]!.id)).toBe("running");
    expect(await p.channel.findUnique({ where: { id: rooms[1] } })).not.toBeNull();
  } finally {
    executor.stopBackgroundShells(bot.id);
    await Promise.all(jobs.map((job) => status(job.id, 5000).catch(() => {})));
    await p.channel.deleteMany({ where: { id: { in: rooms } } });
    await p.bot.delete({ where: { id: bot.id } });
    await p.retiredAgent.deleteMany({ where: { id: { in: rooms } } });
    await p.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
