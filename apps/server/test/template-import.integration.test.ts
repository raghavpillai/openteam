import { test, expect } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { parseBotRecipe } from '@openteam/contracts';
import { AgentDataStore } from '@openteam/messaging';
import { Effect } from 'effect';
import { BotService } from '../src/services/bot-service';
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test('template import materializes memories, skills and setup workflows once, across provisioning retry', async () => {
 if (!url) return;
 const prisma = createPrismaClient(url), root = await mkdtemp(join(tmpdir(), 'template-import-'));
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const service = new BotService(prisma, { send: async () => crypto.randomUUID() } as never, root, async () => Response.json({ ok: true }), data);
 const clientRequestId = crypto.randomUUID(); let botId: string | undefined;
 try {
  const recipe = parseBotRecipe({ profile: { name: 'Reusable research', description: 'Research with citations' }, memory: [{ content: 'Cite primary sources', kind: 'profile' }], skills: [{ name: 'Research', description: 'Research a question', content: 'Collect sources and compare their evidence.' }], routines: [{ slug: 'check-in', description: 'Check a user-selected source', content: 'Ask for the source, destination, and cadence. Monitor for changes.' }], plugins: [{ pluginId: 'search-provider' }], gettingStarted: { skill: 'Research' } });
  const input = { clientRequestId, name: recipe.profile.name, description: recipe.profile.description, instructions: recipe.profile.description };
  const created = await Effect.runPromise(service.create(input, recipe)); botId = created.id;
  const retry = await Effect.runPromise(service.create(input, recipe)); expect(retry.id).toBe(botId);
  const skills = await prisma.savedSkill.findMany({ where: { slug: { startsWith: `template-${botId}-` } } });
  expect(skills).toHaveLength(1);
  expect(await readFile(join(root, 'data/workflows', skills[0]!.slug, 'SKILL.md'), 'utf8')).toContain('Collect sources');
  expect(await readFile(join(root, 'data/agents', botId, 'memory/profile.md'), 'utf8')).toContain('Cite primary sources');
  expect(await readdir(join(root, 'data/agents', botId, 'template-routines'))).toHaveLength(1);
  const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } }); expect(bot.templateRecipe).toBeNull(); expect(bot.instructions).toContain('On the first conversation'); expect(bot.instructions).toContain('Research');
  expect(await prisma.routine.count({ where: { botId } })).toBe(0);
  expect(await prisma.botPluginConnectionGrant.count({ where: { botId } })).toBe(0);
  // Reinitializing after user edits must not replay the seed over the live state.
  await prisma.bot.update({ where: { id: botId }, data: { instructions: 'User edited instructions' } });
  const restarted = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root }); await restarted.initializeBot(botId);
  expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).instructions).toBe('User edited instructions');
 } finally {
  if (botId) { await prisma.savedSkill.deleteMany({ where: { slug: { startsWith: `template-${botId}-` } } }); await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { directKey: `bot:${botId}` } }); }
  await prisma.idempotencyRecord.deleteMany({ where: { scope: 'bot:create', key: clientRequestId } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
 }
});
