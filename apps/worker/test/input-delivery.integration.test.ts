import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { AppService } from '../../server/src/app-service';
import { WakeWorker } from '../src/worker';
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test('worker replays an unacknowledged user input and clears its watermark only after durable delivery', async () => {
 if (!databaseUrl) return;
 const root = await mkdtemp(join(tmpdir(), 'input-delivery-')); let app: AppService | undefined, worker: WakeWorker | undefined;
 const seen: any[] = []; let failed = false;
 const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/health') return Response.json({ status: 'ready', inference: { ready: true, authenticated: true } });
  if (path === '/v1/agent-stores' && request.method === 'GET') return Response.json({ agents: [] });
  if (path === '/v1/infer') {
   const body = await request.json() as { kind: string };
   return Response.json({ text: body.kind === 'verification' ? '{"approved":true}' : body.kind === 'synthesis' ? '{"changes":[]}' : 'NONE' });
  }
  if (path === '/v1/directories') { const body = await request.json() as any; for (const directory of body.paths ?? []) await mkdir(directory, { recursive: true }); return Response.json({ directories: body.paths }); }
  if (path.startsWith('/v1/context-sessions/') && request.method === 'GET') return Response.json({ type: 'context.state', contextSessionId: path.split('/').at(-1), epoch: 0, archives: [] });
  if (path !== '/v1/turns') return Response.json({ ok: true, quarantined: [] });
  const input = await request.json() as any; seen.push(input);
  if (input.content.includes('This user input must survive') && !failed) { failed = true; return new Response('Synthetic pre-insertion interruption', { status: 503 }); }
  await Effect.runPromise(app!.handleDynamicTool({ runId: input.runId, botId: input.botId, conversationId: input.conversationId, channelId: input.channelId, deliveryId: input.deliveryId, callId: `delivery:${input.runId}`, tool: 'SendToUser', arguments: { type: 'text', content: 'Delivery fixture completed' } }));
  const events = [{ type: 'session.attached', runtimeEngine: 'pi', inferenceProvider: 'openai-codex', contextSessionId: input.contextSessionId, sessionPath: input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`, sessionId: input.contextSessionId, model: 'fake' }, { type: 'context.state', contextSessionId: input.contextSessionId, epoch: 0, archives: [] }, { type: 'turn.started', turnId: input.runId }, { type: 'prompt.delivered', turnId: input.runId }, { type: 'turn.completed', turnId: input.runId, status: 'completed' }];
  return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
 } });
 const keys = ['DATABASE_URL', 'OPENTEAM_COMPUTER_URL', 'OPENTEAM_CONTROL_TOKEN', 'OPENTEAM_WORKSPACE_ROOT', 'OPENTEAM_AGENT_DATA_ROOT'] as const; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
 try {
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: fake.url.origin, OPENTEAM_CONTROL_TOKEN: 'synthetic-control', OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, 'data') });
  app = new AppService();
  await app.prisma.$executeRawUnsafe('TRUNCATE TABLE "Computer", "Bot", "OutboxDelivery", "Event", "IdempotencyRecord" CASCADE');
  await Effect.runPromise(app.boot()); worker = new WakeWorker(); await worker.start();
  const bot = await Effect.runPromise(app.createBot({ clientRequestId: crypto.randomUUID(), name: 'Input fixture' }));
  const initial = await Effect.runPromise(app.sendMessage(bot.conversationId, { content: 'This user input must survive', clientId: 'delivery-initial' })) as any;
  const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 300; i++) { if (await check()) return; await Bun.sleep(50); } throw new Error('Delivery fixture timed out'); };
  await until(async () => Boolean((await app!.prisma.run.findUnique({ where: { id: initial.run.id } }))?.inputDeliveredAt));
  const replay = seen.find((input) => input.prependMessages?.some((message: any) => message.id === 'input:delivery-initial'));
  expect(failed).toBe(true); expect(replay).toBeDefined(); expect(replay.prependMessages.find((message: any) => message.id === 'input:delivery-initial').content).toContain('This user input must survive');
  await until(async () => (await app!.prisma.run.findUnique({ where: { id: replay.runId } }))?.status === 'completed');
  const next = await Effect.runPromise(app.sendMessage(bot.conversationId, { content: 'After recovery', clientId: 'delivery-followup' })) as any;
  await until(async () => (await app!.prisma.run.findUnique({ where: { id: next.run.id } }))?.status === 'completed');
  expect(seen.find((input) => input.runId === next.run.id).prependMessages.some((message: any) => message.id === 'input:delivery-initial')).toBe(false);
 } finally { await worker?.stop(); if (app) await Effect.runPromise(app.close()); fake.stop(true); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await rm(root, { recursive: true, force: true }); }
}, 45000);
