import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { ApprovalCardService } from '../src/services/approval-card-service';
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

/** A Bot chat with a live user turn, and a background worker it launched. */
async function fixture(name: string) {
 const prisma = createPrismaClient(databaseUrl!); const root = await mkdtemp(join(tmpdir(), `${name}-`));
 const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const workerId = crypto.randomUUID(), workerConversationId = crypto.randomUUID(), workerChannelId = crypto.randomUUID(), workerRunId = crypto.randomUUID(), routineRunId = crypto.randomUUID();
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 await prisma.bot.create({ data: { id: botId, name: 'Ada', defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } } } });
 await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: 'Ada', members: { create: { botId, ordinal: 0 } } } });
 const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Push the branch', clientId: `fixture-${runId}`, status: 'completed' } });
 await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
 const wake = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Routine', clientId: `fixture-${routineRunId}`, status: 'completed' } });
 await prisma.run.create({ data: { id: routineRunId, botId, conversationId, channelId, userMessageId: wake.id, status: 'running', origin: 'routine' } });
 await prisma.bot.create({ data: { id: workerId, name: 'worker', defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: workerConversationId } } } });
 await prisma.channel.create({ data: { id: workerChannelId, kind: 'agent_dm', directKey: `worker:${workerId}`, name: 'worker', members: { create: { botId: workerId, ordinal: 0 } } } });
 await prisma.subagent.create({ data: { parentBotId: botId, childBotId: workerId, parentRunId: runId, parentChannelId: channelId, launchCallId: 'task-1', description: 'Push', prompt: 'Push', subagentType: 'executor', outputPath: '/tmp/out' } });
 const task = await prisma.message.create({ data: { botId: workerId, conversationId: workerConversationId, role: 'user', content: 'Push', clientId: `fixture-${workerRunId}`, status: 'completed' } });
 await prisma.run.create({ data: { id: workerRunId, botId: workerId, conversationId: workerConversationId, channelId: workerChannelId, userMessageId: task.id, status: 'running', origin: 'agent' } });
 await data.initializeBot(botId); await data.writeRootSettings({});
 const context = (callId: string, run = runId, bot = botId, channel = channelId, conversation = conversationId) =>
  ({ runId: run, botId: bot, conversationId: conversation, channelId: channel, deliveryId: null, origin: 'user' as const, callId, isFork: false, replyToMessageId: null });
 const workerContext = (callId: string) => context(callId, workerRunId, workerId, workerChannelId, workerConversationId);
 const card = async (id: string) => (await prisma.channelMessage.findUniqueOrThrow({ where: { id } }));
 const cleanup = async () => {
  await prisma.autoReviewSettings.deleteMany({ where: { id: 'global' } });
  await prisma.bot.deleteMany({ where: { id: { in: [botId, workerId] } } });
  await prisma.channel.deleteMany({ where: { id: { in: [channelId, workerChannelId] } } });
  await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
 };
 return { prisma, messaging, botId, channelId, runId, routineRunId, context, workerContext, card, cleanup };
}

const shell = { surface: 'box_shell', fingerprint: 'f1', summary: 'Push the release branch on OpenTeam\'s computer', summaryCopy: { kind: 'shell', params: { surface: 'box_shell', description: 'Push the release branch' } }, reason: 'Push the release branch to GitHub. This publishes commits others can see.', command: 'git push origin release', proposedRule: 'Run "git push" commands on OpenTeam\'s computer', expiryPolicy: 'ttl' };

test('approval cards hold one action at a time and settle on the user\'s answer', async () => {
 if (!databaseUrl) return;
 const f = await fixture('approval-card');
 const service = new ApprovalCardService(f.prisma, f.messaging);
 try {
  const first = await service.request(f.context('shell-1'), shell);
  expect(first.status).toBe('pending');
  const id = (first as { approvalId: string }).approvalId;
  const message = await f.card(id);
  expect(message.content).toBe('Allow Ada to run a command?');
  expect(message.metadata).toMatchObject({
   type: 'approval', cardState: 'pending', surface: 'box_shell', expiresAt: null, expiryPolicy: 'park',
   presentation: { title: 'Allow Ada to run a command?', line: 'Push the release branch on OpenTeam\'s computer.', source: 'Terminal', sourceIcon: 'terminal' },
  });
  // A replay of the same call reads the same card.
  expect(await service.request(f.context('shell-1'), shell)).toEqual(first);
  // Only one card waits at a time, including a worker's card for the same bot.
  expect(await service.request(f.context('shell-2'), { ...shell, fingerprint: 'f2' })).toEqual({ status: 'busy' });
  expect(await service.request(f.workerContext('mcp-1'), { ...shell, surface: 'mcp', fingerprint: 'f3' })).toEqual({ status: 'busy' });
  expect(await service.wait(f.context('shell-1'), { approvalId: id }, AbortSignal.abort())).toEqual({ status: 'pending', approvalId: id });

  // "Always allow" approves and saves the proposed rule.
  await Effect.runPromise(service.answer(id, { decision: 'always' }));
  expect(await service.wait(f.context('shell-1'), { approvalId: id })).toEqual({ status: 'always', approvalId: id, savedRule: shell.proposedRule });
  expect((await f.prisma.autoReviewSettings.findUniqueOrThrow({ where: { id: 'global' } })).allowRules).toEqual([shell.proposedRule]);
  // A settled card ignores a second answer.
  expect((await Effect.runPromise(service.answer(id, { decision: 'denied' }))).message.metadata).toMatchObject({ cardState: 'always' });

  // A worker's card goes to the parent's chat, under the parent's name.
  const worker = await service.request(f.workerContext('mcp-1'), { ...shell, surface: 'mcp', fingerprint: 'f3', summaryCopy: { kind: 'mcp', params: { serverDisplayName: 'Linear', action: 'change' } } });
  const workerCard = await f.card((worker as { approvalId: string }).approvalId);
  expect(workerCard).toMatchObject({ channelId: f.channelId, senderBotId: f.botId, content: 'Allow Ada to make changes in Linear?' });
  await Effect.runPromise(service.answer(workerCard.id, { decision: 'denied' }));
  expect(await service.wait(f.workerContext('mcp-1'), { approvalId: workerCard.id })).toEqual({ status: 'denied', approvalId: workerCard.id });

  // Outside a live user turn the card expires after ten minutes.
  const routine = await service.request(f.context('routine-1', f.routineRunId), shell);
  const routineId = (routine as { approvalId: string }).approvalId;
  const stored = await f.card(routineId);
  expect((stored.metadata as any).expiryPolicy).toBe('ttl');
  expect(Date.parse((stored.metadata as any).expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
  await f.prisma.channelMessage.update({ where: { id: routineId }, data: { metadata: { ...(stored.metadata as object), expiresAt: new Date(Date.now() - 1000).toISOString() } } });
  expect(await service.wait(f.context('routine-1', f.routineRunId), { approvalId: routineId })).toEqual({ status: 'expired', approvalId: routineId, retired: 'ttl' });
  // An expired card can no longer be approved.
  expect((await Effect.runPromise(service.answer(routineId, { decision: 'approved' }))).message.metadata).toMatchObject({ cardState: 'expired' });

  // A card whose run stopped no longer blocks the next one.
  const stale = await service.request(f.context('shell-3'), { ...shell, fingerprint: 'f4' });
  await f.prisma.run.update({ where: { id: f.runId }, data: { status: 'interrupted' } });
  await f.prisma.run.update({ where: { id: f.routineRunId }, data: { status: 'running' } });
  const next = await service.request(f.context('routine-2', f.routineRunId), { ...shell, fingerprint: 'f5' });
  expect(next.status).toBe('pending');
  expect((await f.card((stale as { approvalId: string }).approvalId)).metadata).toMatchObject({ cardState: 'expired', retired: 'cancelled' });
  expect(await service.cancel(f.context('routine-2', f.routineRunId), next)).toEqual({ cancelled: true });
  expect((await f.card((next as { approvalId: string }).approvalId)).metadata).toMatchObject({ cardState: 'expired', retired: 'cancelled' });
 } finally {
  await f.cleanup();
 }
});
