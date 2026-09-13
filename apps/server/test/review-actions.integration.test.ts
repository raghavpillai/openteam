import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { ReviewActionService } from '../src/services/review-action-service';
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test('template versions stay private until reviewed; feedback respects privacy, approval, and rate limits', async () => {
 if (!url) return;
 const prisma = createPrismaClient(url); const root = await mkdtemp(join(tmpdir(), 'review-e2e-')); const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 const imported: unknown[] = []; const service = new ReviewActionService(prisma, messaging, { create: (input: unknown, recipe: unknown) => { imported.push({ input, recipe }); return Effect.succeed({ id: 'imported-bot' }); } } as never);
 const deliveries: unknown[] = []; const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { deliveries.push(await request.json()); return Response.json({ accepted: true }); } });
 const keys = ['OPENTEAM_FEEDBACK_ALLOW_AGENT', 'OPENTEAM_FEEDBACK_URL', 'OPENTEAM_PUBLIC_TEMPLATES', 'OPENTEAM_TEMPLATE_SHARING'] as const; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
 try {
  await prisma.bot.create({ data: { id: botId, name: 'Review fixture', defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } } } });
  await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: 'Review fixture', members: { create: { botId, ordinal: 0 } } } });
  const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Share the fixture', clientId: 'fixture', status: 'completed' } });
  await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
  await data.initializeBot(botId); await data.writeRootSettings({});
  const context = { runId, botId, conversationId, channelId, deliveryId: null, origin: 'user' as const, callId: 'template-a', isFork: false, replyToMessageId: null };
  process.env.OPENTEAM_PUBLIC_TEMPLATES = 'true'; process.env.OPENTEAM_TEMPLATE_SHARING = 'true';
  const recipe = { profile: { name: 'Researcher', description: 'Research from sources' }, memory: [{ content: '[note] exclude' }, { content: 'Cite sources' }], skills: [{ name: 'Research', content: 'Read primary sources' }, { name: 'Bad', content: '---\nname: Bad\n---\nWrong' }], routines: [], plugins: [{ pluginId: 'uninstalled-plugin' }], gettingStarted: { skill: 'Research' }, visibility: 'public' };
  const card = await service.stage(context, 'create_bot_share_json', recipe) as { message_id: string; version: number };
  const retry = await service.stage(context, 'create_bot_share_json', recipe) as { message_id: string; version: number };
  expect(retry.message_id).toBe(card.message_id); expect(retry.version).toBe(1);
  await expect(service.recipe(card.message_id, true)).rejects.toThrow('not found');
  const staged = await service.recipe(card.message_id); expect(staged.memory).toHaveLength(1); expect(staged.skills).toHaveLength(1); expect(staged.plugins).toHaveLength(0);
  await Effect.runPromise(service.mutate(card.message_id, { action: 'approve' })); expect((await service.recipe(card.message_id, true)).profile.name).toBe('Researcher');
  await Effect.runPromise(service.mutate(card.message_id, { action: 'import', clientId: 'fixture-import' })); expect(imported).toHaveLength(1); expect(JSON.stringify(imported)).toContain('Read primary sources');
  const next = await service.stage({ ...context, callId: 'template-b' }, 'create_bot_share_json', recipe) as { message_id: string; version: number };
  expect(next.version).toBe(2);
  await Effect.runPromise(service.mutate(next.message_id, { action: 'approve' }));
  await expect(service.recipe(card.message_id, true)).rejects.toThrow('not found');
  await Effect.runPromise(service.mutate(next.message_id, { action: 'unpublish' }));
  await expect(service.recipe(next.message_id, true)).rejects.toThrow('not found');
  await Effect.runPromise(service.mutate(next.message_id, { action: 'approve' }));
  expect((await service.recipe(next.message_id, true)).profile.name).toBe('Researcher');
  process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT = 'false'; process.env.OPENTEAM_FEEDBACK_URL = server.url.href;
  await expect(service.stage({ ...context, callId: 'feedback-blocked' }, 'SendFeedback', { message: 'Make it faster', wantsResponse: false })).rejects.toThrow('privacy');
  process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT = 'true';
  const feedback = await service.stage({ ...context, callId: 'feedback-a' }, 'SendFeedback', { message: 'Make it faster', wantsResponse: false }) as { message_id: string };
  expect(deliveries).toHaveLength(0);
  await Promise.all([Effect.runPromise(service.mutate(feedback.message_id, { action: 'approve' })), Effect.runPromise(service.mutate(feedback.message_id, { action: 'approve' }))]);
  expect(deliveries).toEqual([{ id: feedback.message_id, product: 'OpenTeam', message: 'Make it faster', wantsResponse: false }]);
  const limited = await service.stage({ ...context, callId: 'feedback-b' }, 'SendFeedback', { message: 'Second feedback', wantsResponse: false }) as { message_id: string };
  await expect(Effect.runPromise(service.mutate(limited.message_id, { action: 'approve' }))).rejects.toThrow('rate limited'); expect(deliveries).toHaveLength(1);
 } finally {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  server.stop(true); await prisma.idempotencyRecord.deleteMany({ where: { scope: `template-version:${botId}` } }); await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { id: channelId } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
 }
});
