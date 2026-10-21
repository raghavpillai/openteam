import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { SharedTemplateService } from '../src/services/shared-template-service';
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test('templates stage as drafts the owner publishes', async () => {
 if (!url) return;
 const prisma = createPrismaClient(url); const root = await mkdtemp(join(tmpdir(), 'review-e2e-')); const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 const imported: unknown[] = []; const service = new SharedTemplateService(prisma, messaging, { create: (input: unknown, recipe: unknown) => { imported.push({ input, recipe }); return Effect.succeed({ id: 'imported-bot' }); } } as never);
 const keys = ['OPENTEAM_PUBLIC_TEMPLATES', 'OPENTEAM_TEMPLATE_SHARING'] as const; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
 try {
  await prisma.bot.create({ data: { id: botId, name: 'Review fixture', defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } } } });
  await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: 'Review fixture', members: { create: { botId, ordinal: 0 } } } });
  const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Share the fixture', clientId: 'fixture', status: 'completed' } });
  await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
  await data.initializeBot(botId); await data.writeRootSettings({});
  const context = { runId, botId, conversationId, channelId, deliveryId: null, origin: 'user' as const, callId: 'template-a', isFork: false, replyToMessageId: null };
  process.env.OPENTEAM_PUBLIC_TEMPLATES = 'true'; process.env.OPENTEAM_TEMPLATE_SHARING = 'true';
  const recipe = { profile: { name: 'Researcher', description: 'Research from sources' }, memory: [{ content: '[note] exclude' }, { content: 'Cite sources' }], skills: [{ name: 'Research', content: 'Read primary sources' }, { name: 'Bad', content: '---\nname: Bad\n---\nWrong' }], routines: [], plugins: [{ pluginId: 'uninstalled-plugin' }], gettingStarted: { skill: 'Research' }, visibility: 'public' };
  const card = await service.publish(context, recipe) as { message_id: string; version: number; staged: boolean; name: string };
  expect(card).toMatchObject({ staged: true, name: 'Researcher', version: 1 });
  const retry = await service.publish(context, recipe) as { message_id: string; version: number };
  expect(retry.message_id).toBe(card.message_id); expect(retry.version).toBe(1);
  // A staged draft is private and cannot be imported until the owner publishes it.
  const draft = await prisma.channelMessage.findUniqueOrThrow({ where: { id: card.message_id } });
  expect(draft.metadata).toMatchObject({ cardState: 'draft', outcomeEchoed: true });
  await expect(service.recipe(card.message_id, true)).rejects.toThrow('not found');
  await expect(Effect.runPromise(service.mutate(card.message_id, { action: 'import', clientId: 'early-import' }))).rejects.toThrow('Publish this template before importing');
  const published = await Effect.runPromise(service.mutate(card.message_id, { action: 'publish' }));
  expect(published.message.metadata).toMatchObject({ cardState: 'published', outcomeText: 'The user published template version 1 with public visibility.', outcomeEchoed: false });
  expect((await service.recipe(card.message_id, true)).profile.name).toBe('Researcher');
  const staged = await service.recipe(card.message_id); expect(staged.memory).toHaveLength(1); expect(staged.skills).toHaveLength(1); expect(staged.plugins).toHaveLength(0);
  await Effect.runPromise(service.mutate(card.message_id, { action: 'import', clientId: 'fixture-import' })); expect(imported).toHaveLength(1); expect(JSON.stringify(imported)).toContain('Read primary sources');
  const next = await service.publish({ ...context, callId: 'template-b' }, recipe) as { message_id: string; version: number };
  expect(next.version).toBe(2);
  // The published version stays live until the owner publishes the new draft.
  expect((await service.recipe(card.message_id, true)).profile.name).toBe('Researcher');
  await Effect.runPromise(service.mutate(next.message_id, { action: 'publish' }));
  await expect(service.recipe(card.message_id, true)).rejects.toThrow('not found');
  await Effect.runPromise(service.mutate(next.message_id, { action: 'unpublish' }));
  await expect(service.recipe(next.message_id, true)).rejects.toThrow('not found');
 } finally {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await prisma.idempotencyRecord.deleteMany({ where: { scope: `template-version:${botId}` } }); await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { id: channelId } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
 }
});
