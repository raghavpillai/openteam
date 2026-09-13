import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { ExternalDraftService } from '../src/services/external-draft-service';
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test('reviewed drafts verify accounts, persist edits, reject route changes and send at most once', async () => {
 if (!databaseUrl) return;
 const prisma = createPrismaClient(databaseUrl); const root = await mkdtemp(join(tmpdir(), 'draft-e2e-'));
 const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 const sent: Array<{ toolName: string; arguments: any }> = []; let sender = 'author@example.com'; let uncertain = false;
 const plugins = {
  invoke: async (input: any) => input.toolName === 'get_message' ? { subject: 'Original' } : { threads: [{ messages: [{ sender, labelIds: ['SENT'] }] }] },
  invokeReviewed: async (input: any) => { sent.push(input); if (uncertain) throw new Error('Connection lost after remote side effect'); return { id: 'provider-message-id' }; },
 };
 const service = new ExternalDraftService(prisma, messaging, plugins as never);
 try {
  await prisma.bot.create({ data: { id: botId, name: 'Draft fixture', defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } } } });
  await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: 'Draft fixture', members: { create: { botId, ordinal: 0 } } } });
  const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Draft an email', clientId: 'fixture', status: 'completed' } });
  await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
  await data.initializeBot(botId); await data.writeRootSettings({});
  const context = { runId, botId, conversationId, channelId, deliveryId: null, origin: 'user' as const, callId: 'draft-a', isFork: false, replyToMessageId: null };
  const draft = { platform: 'email', providerIdentifier: 'synthetic-connector', from: sender, to: ['recipient@example.com'], subject: 'Subject', body: 'First body' };
  const card = await service.create(context, draft) as { message_id: string };
  expect(sent).toHaveLength(0);
  await expect(Effect.runPromise(service.mutate(card.message_id, { action: 'send', edits: { providerIdentifier: 'different' } }))).rejects.toThrow('cannot be changed');
  const results = await Promise.all([Effect.runPromise(service.mutate(card.message_id, { action: 'send', edits: { body: 'Human edited body', to: ['edited@example.com'] } })), Effect.runPromise(service.mutate(card.message_id, { action: 'send' }))]);
  expect(sent).toHaveLength(1); expect(sent[0]!.arguments).toMatchObject({ body: 'Human edited body', to: ['edited@example.com'] });
  expect(results.some((result) => (result.message.metadata as any).cardState === 'sent')).toBe(true);
  expect(await prisma.inboxEvent.count({ where: { botId, type: 'draft.response' } })).toBe(1);
  const stale = await service.create({ ...context, callId: 'draft-b' }, draft) as { message_id: string };
  sender = 'different@example.com';
  expect((await Effect.runPromise(service.mutate(stale.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'failed' }); expect(sent).toHaveLength(1);
  sender = draft.from;
  const interrupted = await service.create({ ...context, callId: 'draft-c' }, draft) as { message_id: string };
  uncertain = true;
  expect((await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'unknown' });
  await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' })); expect(sent).toHaveLength(2);
  const reply = await service.create({ ...context, callId: 'draft-d' }, { ...draft, replyToMessageId: 'original' }) as { message_id: string };
  uncertain = false;
  await Effect.runPromise(service.mutate(reply.message_id, { action: 'send' }));
  expect(sent.slice(-2).map((item) => item.toolName)).toEqual(['create_draft', 'send_message']); expect(sent.at(-1)!.arguments).toEqual({ draftId: 'provider-message-id' });
 } finally { await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { id: channelId } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); }
});
