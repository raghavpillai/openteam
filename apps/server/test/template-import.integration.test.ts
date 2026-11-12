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
  const input = { clientRequestId, name: recipe.profile.name, description: recipe.profile.description };
  const created = await Effect.runPromise(service.create(input, recipe)); botId = created.id; expect(created.instructions).toBe("");
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
 } finally {
  if (botId) { await prisma.savedSkill.deleteMany({ where: { slug: { startsWith: `template-${botId}-` } } }); await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { directKey: `bot:${botId}` } }); }
  await prisma.idempotencyRecord.deleteMany({ where: { scope: 'bot:create', key: clientRequestId } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
 }
});
