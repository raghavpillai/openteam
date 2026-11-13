import { expect } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBotRecipe } from '@openteam/contracts';
import { AgentDataStore } from '@openteam/messaging';
import { Effect } from 'effect';
import { BotService } from '../src/services/bot-service';
import { SharedTemplateService } from '../src/services/shared-template-service';
import { dbIt, fakeBoss } from './harness';
dbIt('template import materializes memories, skills and setup workflows once, across provisioning retry', async ({ db: prisma, dir: root, store: data, botIds, onClose }) => {
 const service = new BotService(prisma, fakeBoss(), root, async () => Response.json({ ok: true }), data);
 const clientRequestId = crypto.randomUUID(); let botId = '';
 onClose(async () => { await prisma.savedSkill.deleteMany({ where: { slug: { startsWith: `template-${botId}-` } } }); await prisma.idempotencyRecord.deleteMany({ where: { scope: 'bot:create', key: clientRequestId } }); });
 {
  const recipe = parseBotRecipe({ profile: { name: 'Reusable research', description: 'Research with citations' }, memory: [{ content: 'Cite primary sources', kind: 'profile' }], skills: [{ name: 'Research', description: 'Research a question', content: 'Collect sources and compare their evidence.' }], routines: [{ slug: 'check-in', description: 'Check a user-selected source', content: 'Ask for the source, destination, and cadence. Monitor for changes.' }], plugins: [{ pluginId: 'search-provider' }], gettingStarted: { skill: 'Research' } });
  const input = { clientRequestId, name: recipe.profile.name, description: recipe.profile.description };
  const created = await Effect.runPromise(service.create(input, recipe)); botId = created.id; botIds.add(botId); expect(created.instructions).toBe("");
  const retry = await Effect.runPromise(service.create(input, recipe)); expect(retry.id).toBe(botId);
  const skills = await prisma.savedSkill.findMany({ where: { slug: { startsWith: `template-${botId}-` } } });
  expect(skills).toHaveLength(1);
  expect(await readFile(join(root, 'data/workflows', skills[0]!.slug, 'SKILL.md'), 'utf8')).toContain('Collect sources');
  expect(await prisma.memoryFact.findMany({ where: { namespace: `agent:${botId}` }, select: { fact: true, tier: true, origin: true } })).toEqual(expect.arrayContaining([{ fact: 'Cite primary sources', tier: 'profile', origin: 'template' }]));
  expect(await readdir(join(root, 'data/agents', botId, 'template-routines'))).toHaveLength(1);
  const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } }); expect(bot.templateRecipe).toBeNull(); const setup = await prisma.memoryFact.findFirstOrThrow({ where: { namespace: `agent:${botId}`, fact: { contains: 'On the first conversation' } } }); expect(setup.fact).toContain('Research');
  expect(await prisma.routine.count({ where: { botId } })).toBe(0);
  // Reinitializing after user edits must not replay the seed over the live state.
  const updated = await Effect.runPromise(service.update(botId, { title: 'Researcher', description: 'Updated profile' })); expect(updated.title).toBe('Researcher'); expect(updated.instructions).toBe('');
  const restarted = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root }); await restarted.initializeBot(botId);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).description).toBe('Updated profile'); expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(5);
 }
});

dbIt('templates stage as drafts the owner publishes', async ({ db: prisma, messaging, bot, run, context: toolContext }) => {
 const imported: unknown[] = []; const service = new SharedTemplateService(prisma, messaging, { create: (input: unknown, recipe: unknown) => { imported.push({ input, recipe }); return Effect.succeed({ id: 'imported-bot' }); } } as never);
 const keys = ['OPENTEAM_PUBLIC_TEMPLATES', 'OPENTEAM_TEMPLATE_SHARING'] as const; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
 try {
  const owner = await bot('Review fixture');
  const user = await prisma.message.create({ data: { botId: owner.id, conversationId: owner.conversationId, role: 'user', content: 'Share the fixture', clientId: 'fixture', status: 'completed' } });
  const context = toolContext(owner, { runId: (await run(owner, { userMessageId: user.id })).id, callId: 'template-a' });
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
 }
});
