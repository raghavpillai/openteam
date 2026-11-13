import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging, lockAgentLifecycle } from '@openteam/messaging';
import { Effect } from 'effect';
import { ExternalDraftService } from '../src/services/external-draft-service';

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = test.skipIf(!databaseUrl);
/** A Bot chat plus a connector account that declares reviewed sending. */
async function fixture(name: string) {
 const prisma = createPrismaClient(databaseUrl!); const root = await mkdtemp(join(tmpdir(), `${name}-`));
 const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), contextId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const pluginKey = `mail-${crypto.randomUUID().slice(0, 8)}`;
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 const installation = await prisma.pluginInstallation.create({ data: { pluginKey, version: '1.0.0', name: 'Mail', publisher: 'Test', manifest: { key: pluginKey, name: 'Mail', skills: [], connections: [{ key: 'email', transport: 'stdio', drafts: { platform: 'email', tool: 'send_reviewed_email' } }] } } });
 const connection = await prisma.pluginConnection.create({ data: { installationId: installation.id, connectorKey: 'email', name: 'Mail', transport: 'stdio', authType: 'none', status: 'ready' } });
 await prisma.bot.create({ data: { id: botId, name: `${name} fixture`, defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } }, contextSessions: { create: { id: contextId, scope: 'home', scopeId: conversationId } } } });
 await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: `${name} fixture`, members: { create: { botId, ordinal: 0 } } } });
 const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Draft an email', clientId: 'fixture', status: 'completed' } });
 await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
 await data.initializeBot(botId); await data.writeRootSettings({});
 const context = (callId: string) => ({ runId, botId, conversationId, channelId, deliveryId: null, origin: 'user' as const, callId, isFork: false, replyToMessageId: null });
 const card = async (id: string) => (await prisma.channelMessage.findUniqueOrThrow({ where: { id } })).metadata as any;
 const cleanup = async () => { await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { id: channelId } }); await prisma.pluginInstallation.deleteMany({ where: { pluginKey } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); };
 return { prisma, messaging, botId, contextId, connection, context, card, cleanup };
}


const draft = (providerIdentifier: string) => ({
 platform: 'email', providerIdentifier, from: 'me@example.com', to: ['ann@example.com'],
 subject: 'Lifecycle boundary', body: 'Synthetic connector only; no external transport',
});

/** Exercise the durable retirement phase only. No runtime cleanup or remote call. */
async function retire(db: ReturnType<typeof createPrismaClient>, botId: string, channelId: string) {
 await db.$transaction(async tx => {
  await lockAgentLifecycle(tx, botId);
  await tx.run.updateMany({ where: { botId, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', completedAt: new Date() } });
  await tx.inboxEvent.updateMany({ where: { botId, status: { in: ['pending', 'processing'] } }, data: { status: 'completed', completedAt: new Date() } });
  await tx.bot.update({ where: { id: botId }, data: { status: 'archived' } });
  await tx.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
 });
}

const deferred = () => {
 let resolve!: () => void;
 const promise = new Promise<void>(done => resolve = done);
 return { promise, resolve };
};

async function retirementWaitsForLifecycle(
 db: ReturnType<typeof createPrismaClient>, botId: string, committed: () => boolean
) {
 const key = `agent-lifecycle:${botId}`;
 const deadline = Date.now() + 5_000;
 while (Date.now() < deadline) {
  if (committed()) return false;
  const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(
   SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
    AND objid = (hashtext(${key})::bigint & 4294967295)::oid AND NOT granted) AS waiting`;
  if (rows[0]?.waiting) return true;
  await Bun.sleep(10);
 }
 throw new Error('Retirement neither committed nor reached the lifecycle lock');
}

databaseTest('archive-first preserves late known outcomes without waking the retired bot', async () => {
 for (const variant of ['control', 'treatment'] as const) for (const result of ['confirmed', 'uncertain', 'account-change'] as const) {
  const f = await fixture(`lifecycle-${variant}-${result}`), entered = deferred(), release = deferred();
  let verifies = 0, sends = 0;
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') {
    verifies++;
    if (result === 'account-change' && verifies > 1) { entered.resolve(); await release.promise; return { identity: 'other@example.com', sendingAddresses: ['me@example.com'] }; }
    return { identity: 'me@example.com' };
   }
   sends++; entered.resolve(); await release.promise;
   if (result === 'uncertain') throw new Error('Synthetic response loss after transport entry');
   return { id: 'synthetic-confirmed' };
  } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  let sending: Promise<any> | undefined;
  try {
   const card = await service.create(f.context('archive-first'), draft(f.connection.id)) as any;
   sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })).then(value => ({ value }), error => ({ error }));
   await entered.promise;
   await retire(f.prisma, f.botId, f.context('').channelId);
   release.resolve(); const response = await sending;
   expect(response.error).toBeUndefined();
   const stored = await f.card(card.message_id);
   expect(stored.cardState).toBe(result === 'confirmed' ? 'sent' : result === 'uncertain' ? 'unknown' : 'failed');
   expect(stored.outcomeId).toEqual(expect.any(String));
   expect(stored.outcomeEchoed).toBe(false);
   expect(sends).toBe(result === 'account-change' ? 0 : 1);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
   expect(await f.prisma.run.count({ where: { botId: f.botId, status: { in: ['queued', 'running'] } } })).toBe(0);
  } finally { release.resolve(); await sending; await f.cleanup(); }
 }
}, 30_000);

databaseTest('a late confirmed send to an archived channel persists without queuing another turn', async () => {
 const f = await fixture('channel-archive-first'), entered = deferred(), release = deferred();
 let sends = 0;
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
  sends++; entered.resolve(); await release.promise; return { id: 'synthetic-confirmed' };
 } } as never, { treatmentPercent: '100' });
 let sending: Promise<any> | undefined;
 try {
  const card = await service.create(f.context('channel-archive'), draft(f.connection.id)) as any;
  sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await entered.promise;
  await f.prisma.channel.update({ where: { id: f.context('').channelId }, data: { archivedAt: new Date() } });
  release.resolve(); await sending;
  expect((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).status).toBe('active');
  expect(await f.card(card.message_id)).toMatchObject({ cardState: 'sent', outcomeId: expect.any(String), outcomeEchoed: false });
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
  expect(sends).toBe(1);
 } finally { release.resolve(); await sending; await f.cleanup(); }
});

databaseTest('settlement-first holds retirement until its wake is in the cancellation snapshot', async () => {
 for (const variant of ['control', 'treatment'] as const) {
  const f = await fixture(`settlement-first-${variant}`), retirementDb = createPrismaClient(databaseUrl!);
  const entered = deferred(), release = deferred();
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => ({ identity: 'me@example.com' }) } as never,
   { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  const transaction = f.prisma.$transaction.bind(f.prisma);
  let armed = false, committed = false, cancelling: Promise<any> | undefined, retiring: Promise<any> | undefined;
  try {
   const card = await service.create(f.context('settlement-first'), draft(f.connection.id)) as any;
   // Pause after enqueueWake has read an active owner, before creating its Run.
   // Returning a plain Promise here is intentional; production only awaits this query.
   f.prisma.$transaction = ((work: any, options: any) => transaction(async (tx: any) => {
    const read = tx.bot.findUnique.bind(tx.bot);
    tx.bot.findUnique = async (args: any) => {
     const value = await read(args);
     if (armed && args.where?.id === f.botId && args.include?.conversation) { armed = false; entered.resolve(); await release.promise; }
     return value;
    };
    return work(tx);
   }, options)) as typeof f.prisma.$transaction;
   armed = true;
   cancelling = Effect.runPromise(service.mutate(card.message_id, { action: 'cancel' })).then(value => ({ value }), error => ({ error }));
   await entered.promise;
   retiring = retire(retirementDb, f.botId, f.context('').channelId).then(() => { committed = true; });
   const waiting = await retirementWaitsForLifecycle(retirementDb, f.botId, () => committed);
   release.resolve(); const response = await cancelling; await retiring;
   expect(waiting).toBe(true);
   expect(response.error).toBeUndefined();
   expect(await f.card(card.message_id)).toMatchObject({ cardState: 'dismissed', outcomeId: expect.any(String) });
   expect(await f.prisma.run.count({ where: { botId: f.botId, status: { in: ['queued', 'running'] } } })).toBe(0);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, status: 'pending' } })).toBe(0);
   const outcome = await f.prisma.inboxEvent.findFirstOrThrow({ where: { botId: f.botId, type: 'draft.response' } });
   expect(outcome.status).toBe('completed');
  } finally {
   release.resolve(); await Promise.allSettled([cancelling, retiring].filter(Boolean) as Promise<unknown>[]);
   f.prisma.$transaction = transaction as typeof f.prisma.$transaction;
   await retirementDb.$disconnect(); await f.cleanup();
  }
 }
}, 30_000);

databaseTest('retirement-first refuses a discard already waiting on the lifecycle lock', async () => {
 const f = await fixture('retirement-before-discard'), acquired = deferred(), release = deferred();
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => ({ identity: 'me@example.com' }) } as never,
  { treatmentPercent: '100' });
 let cancelling: Promise<any> | undefined, retiring: Promise<unknown> | undefined;
 try {
  const card = await service.create(f.context('retirement-before-discard'), draft(f.connection.id)) as any;
  retiring = f.prisma.$transaction(async tx => {
   await lockAgentLifecycle(tx, f.botId); acquired.resolve(); await release.promise;
   await tx.run.updateMany({ where: { botId: f.botId, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', completedAt: new Date() } });
   await tx.bot.update({ where: { id: f.botId }, data: { status: 'archived' } });
   await tx.channel.update({ where: { id: f.context('').channelId }, data: { archivedAt: new Date() } });
  });
  await acquired.promise;
  cancelling = Effect.runPromise(service.mutate(card.message_id, { action: 'cancel' })).then(value => ({ value }), error => ({ error: String(error) }));
  expect(await retirementWaitsForLifecycle(f.prisma, f.botId, () => false)).toBe(true);
  release.resolve(); await retiring; const response = await cancelling;
  expect(response.error).toContain('Draft card not found');
  expect((await f.card(card.message_id)).outcomeId).toBeUndefined();
  expect((await f.card(card.message_id)).cardState ?? 'pending').toBe('pending');
  expect(await f.prisma.run.count({ where: { botId: f.botId, status: { in: ['queued', 'running'] } } })).toBe(0);
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
 } finally {
  release.resolve(); await Promise.allSettled([cancelling, retiring].filter(Boolean) as Promise<unknown>[]); await f.cleanup();
 }
}, 30_000);
