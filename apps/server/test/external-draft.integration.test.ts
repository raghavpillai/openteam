import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging, publishDraftNotification, DRAFT_NOTIFICATION_COLLECTION_MS } from '@openteam/messaging';
import { Effect } from 'effect';
import { ExternalDraftService } from '../src/services/external-draft-service';
import { loadConnectionNamespaces } from '../src/services/plugin/namespaces';
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

const abResults: Array<Record<string, unknown>> = [];
async function recordAB(result: Record<string, unknown>) {
 abResults.push(result);
 console.log('Draft notification A/B:', JSON.stringify(result));
 if (process.env.OPENTEAM_DRAFT_AB_REPORT) await Bun.write(process.env.OPENTEAM_DRAFT_AB_REPORT,
  JSON.stringify({ method: 'controlled PostgreSQL fault injection; mocked mail transport and model text; not live user traffic', results: abResults }, null, 2));
}

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

test('connectors that declare reviewed sending verify, edit and send each card at most once', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-host');
 const calls: any[] = []; let identity = 'me@example.com'; let failSend: 'before' | 'after' | null = null;
 const plugins = { invoke: async (input: any) => {
  calls.push(input);
  if (input.arguments.action === 'verify') {
   if (failSend === 'before') throw new Error('Mail server unreachable');
   return { identity, sendingAddresses: ['me@example.com', 'alias@example.com'], signatures: { 'alias@example.com': '<b>Alias</b>', 'stranger@example.com': 'x' }, thread: '“Invoice question” from Ann', threadUrl: 'https://mail.example.com/thread/1' };
  }
  if (failSend === 'after') throw new Error('Connection lost after remote side effect');
  return { id: 'sent-1' };
 } };
 const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never);
 try {
  const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'Me@Example.com', to: ['ann@example.com'], subject: 'Re: Invoice question', body: 'It is $1,250.', replyToMessageId: 'msg-42' };
  const card = await service.create(f.context('reply-a'), draft) as { message_id: string };
  expect(calls[0]).toMatchObject({ connectionId: f.connection.id, toolName: 'send_reviewed_email', hostTool: true, arguments: { action: 'verify', draft: { from: 'Me@Example.com', replyToMessageId: 'msg-42' } } });
  expect((await f.card(card.message_id)).draft.verification).toEqual({ identity: 'me@example.com', destination: 'ann@example.com', sendingAddresses: ['me@example.com', 'alias@example.com'], signatures: { 'alias@example.com': '<b>Alias</b>' }, thread: '“Invoice question” from Ann', threadUrl: 'https://mail.example.com/thread/1' });
  expect((await f.card(card.message_id)).cardState).toBeUndefined();
  await expect(Effect.runPromise(service.mutate(card.message_id, { action: 'send', edits: { providerIdentifier: 'different' } }))).rejects.toThrow('cannot be changed');
  await expect(Effect.runPromise(service.mutate(card.message_id, { action: 'send', edits: { from: 'stranger@example.com' } }))).rejects.toThrow('verified addresses');
  await Promise.all([
   Effect.runPromise(service.mutate(card.message_id, { action: 'send', edits: { from: 'alias@example.com', body: 'It is $1,250. Thanks!', to: ['ann@example.com'], cc: ['bob@example.com'], subject: 'Re: Invoice question' } })),
   Effect.runPromise(service.mutate(card.message_id, { action: 'send' })),
  ]);
  const sends = calls.filter((call) => call.arguments.action === 'send');
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ callId: `draft-send:${card.message_id}:send`, hostTool: true, arguments: { draft: { from: 'alias@example.com', cc: ['bob@example.com'], body: 'It is $1,250. Thanks!', replyToMessageId: 'msg-42', signatureHtml: '<b>Alias</b>' } } });
  expect(sends[0].arguments.draft.html).toContain('It is $1,250. Thanks!');
  const settled = await f.card(card.message_id);
  expect(settled.cardState).toBe('sent');
  expect(settled.outcomeText).toStartWith('The user sent the reviewed message.\n\nFrom: alias@example.com\nTo: ann@example.com\nCc: bob@example.com\nSubject: Re: Invoice question\nIn reply to: “Invoice question” from Ann (msg-42)\n\nIt is $1,250. Thanks!');
  expect(settled.outcomeText).not.toContain('Reviewed content');
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);

  // Nothing went out: the card stays editable and says why, and the Bot keeps waiting.
  const retry = await service.create(f.context('reply-b'), draft) as { message_id: string };
  failSend = 'before';
  const reopened = await Effect.runPromise(service.mutate(retry.message_id, { action: 'send' }));
  expect(reopened.message.metadata).toMatchObject({ cardState: 'pending', sendError: 'Mail server unreachable' });
  failSend = null;
  await Effect.runPromise(service.mutate(retry.message_id, { action: 'send' }));
  expect(await f.card(retry.message_id)).toMatchObject({ cardState: 'sent' });
  expect((await f.card(retry.message_id)).sendError).toBeUndefined();

  // An unconfirmed send waits for the next turn; discarding wakes the Bot exactly once.
  const wakes = () => f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } });
  const wakesBefore = await wakes();
  const interrupted = await service.create(f.context('reply-c'), draft) as { message_id: string };
  failSend = 'after';
  expect((await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'unknown', outcomeEchoed: false });
  expect((await f.card(interrupted.message_id)).outcomeText).toStartWith('A send of your draft did not confirm. It may or may not have gone out. Do not send that message yourself (including via CallDynamicTool or any connector send tool). Check the destination before drafting or sending it again.\n\nFrom: Me@Example.com');
  const before = calls.length;
  await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' }));
  expect(calls).toHaveLength(before);
  failSend = null;
  const discarded = await service.create(f.context('reply-x'), draft) as { message_id: string };
  await Effect.runPromise(service.mutate(discarded.message_id, { action: 'cancel' }));
  expect(await f.card(discarded.message_id)).toMatchObject({ cardState: 'dismissed', outcomeEchoed: false });
  expect((await f.card(discarded.message_id)).outcomeText).toStartWith('The user discarded your draft without sending. They refused to send it. Do not send that message yourself (including via CallDynamicTool or any connector send tool), and do not ask them to press Send on it. Treat the draft as rejected; only draft or send again if the user explicitly asks.');
  expect(await wakes()).toBe(wakesBefore + 1);
  await Effect.runPromise(service.mutate(discarded.message_id, { action: 'cancel' }));
  expect(await wakes()).toBe(wakesBefore + 1);
  const nextTurn = await f.messaging.platformPrompt(f.botId, f.contextId, '', null);
  expect(JSON.stringify(nextTurn)).toContain('The user discarded your draft without sending.');

  const stale = await service.create(f.context('reply-d'), draft) as { message_id: string };
  identity = 'someone-else@example.com';
  expect((await Effect.runPromise(service.mutate(stale.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'failed' });
  await expect(service.create(f.context('reply-e'), { ...draft, from: 'nobody@example.com' })).rejects.toThrow(
   'Draft refused: from (nobody@example.com) is not the address this account really sends as (someone-else@example.com, me@example.com, alias@example.com). Nothing was drafted. Call this tool again with from: someone-else@example.com or one of the other addresses listed.'
  );
  failSend = 'before';
  await expect(service.create(f.context('reply-z'), draft)).rejects.toThrow('Draft refused: the routing could not be verified through the connector (');
  failSend = null;
  await expect(service.create(f.context('reply-f'), { ...draft, providerIdentifier: 'not-a-connection' })).rejects.toThrow("can't send reviewed email");
  // GetMcpServerStatus lists accounts by namespace; drafts accept that form too.
  identity = 'me@example.com';
  const namespace = (await loadConnectionNamespaces(f.prisma)).get(f.connection.id)!;
  expect(namespace).toStartWith('mail');
  const namespaced = await service.create(f.context('reply-g'), { ...draft, providerIdentifier: namespace }) as { message_id: string };
  expect(calls.at(-1)).toMatchObject({ connectionId: f.connection.id, toolName: 'send_reviewed_email' });
  await Effect.runPromise(service.mutate(namespaced.message_id, { action: 'send' }));
  expect(await f.card(namespaced.message_id)).toMatchObject({ cardState: 'sent' });
  expect(calls.at(-1)).toMatchObject({ connectionId: f.connection.id, arguments: { action: 'send' } });
  // A renamed account's old namespace names no connection.
  await expect(service.create(f.context('reply-h'), { ...draft, providerIdentifier: `${namespace}--work` })).rejects.toThrow("can't send reviewed email");
 } finally { await f.cleanup(); }
});

test('attachment review sends immutable previewed bytes and refuses missing assets before sending', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-files');
 const { writeFile } = await import('node:fs/promises');
 const path = join((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).defaultDirectory, 'review.txt');
 const calls: any[] = [];
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  calls.push(input); return input.arguments.action === 'verify' ? { identity: 'me@example.com', forwarding: '“Original” from Ann', forwardUrl: 'https://mail.example.com/original' } : { id: 'sent' };
 } } as never);
 const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Fwd: Original', body: 'Please review.', forwardMessageId: 'original-1', attachments: [path] };
 try {
  await writeFile(path, 'These are the reviewed bytes.');
  const first = await service.create(f.context('files-a'), draft) as { message_id: string };
  const saved = await f.card(first.message_id);
  expect(saved.draft.verification).toMatchObject({ forwarding: '“Original” from Ann', attachments: [{ fileName: 'review.txt', byteSize: 29 }] });
  await writeFile(path, 'The source file changed after review.');
  await Effect.runPromise(service.mutate(first.message_id, { action: 'send' }));
  const sent = calls.find(call => call.arguments.action === 'send').arguments.draft;
  expect(sent.forwardMessageId).toBe('original-1');
  expect(Buffer.from(sent.attachments[0].content, 'base64').toString()).toBe('These are the reviewed bytes.');
  const second = await service.create(f.context('files-b'), draft) as { message_id: string };
  const asset = (await f.card(second.message_id)).draft.verification.attachments[0];
  await rm(f.messaging.assets.contentPath(asset.assetId));
  const before = calls.filter(call => call.arguments.action === 'send').length;
  const refused = await Effect.runPromise(service.mutate(second.message_id, { action: 'send' }));
  expect(refused.message.metadata).toMatchObject({ cardState: 'pending' });
  expect(calls.filter(call => call.arguments.action === 'send')).toHaveLength(before);
  await expect(service.create(f.context('files-c'), { ...draft, attachments: [path + '.missing'] })).rejects.toThrow();
 } finally { await f.cleanup(); }
});

test('bulk draft outcomes are claimed as one continuation rather than 24 repeated confirmations', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-batch');
 const { WakeWorker } = await import('../../worker/src/worker');
 const worker = Object.create(WakeWorker.prototype) as any;
 Object.assign(worker, { prisma: f.prisma, messaging: f.messaging, workspaceRoot: f.messaging.agentData.workspaceRoot });
 try {
  for (let i = 0; i < 24; i++) await f.prisma.$transaction(tx => f.messaging.enqueueWake(tx, {
   botId: f.botId, channelId: f.context('batch').channelId, origin: 'user', type: 'draft.response',
   content: '[SAND_HIDDEN_PROMPT]A draft settled.', clientId: `draft:${crypto.randomUUID()}:outcome`, priority: 400, wrapUserContent: false,
  }));
  const claimed = await worker.claim(f.botId);
  expect(claimed.content).toContain('24 external message draft outcome(s)');
  const events = await f.prisma.inboxEvent.findMany({ where: { botId: f.botId }, include: { run: true } });
  expect(events.filter(event => event.status === 'processing')).toHaveLength(1);
  expect(events.filter(event => event.status === 'completed' && event.run.status === 'completed')).toHaveLength(23);
  expect(events.filter(event => event.status === 'pending')).toHaveLength(0);
  expect(await worker.claim(f.botId)).toBeNull();
 } finally { await f.cleanup(); }
});

test('same-subject outcomes retain distinct card identities after ambient receipts were consumed', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-identity');
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => ({ identity: 'me@example.com' }) } as never);
 const { WakeWorker } = await import('../../worker/src/worker');
 const worker = Object.create(WakeWorker.prototype) as any;
 Object.assign(worker, { prisma: f.prisma, messaging: f.messaging, workspaceRoot: f.messaging.agentData.workspaceRoot });
 try {
  const cards = [];
  for (const day of ['Monday', 'Tuesday']) {
   const card = await service.create(f.context(day), { platform: 'email', providerIdentifier: f.connection.id,
    from: 'me@example.com', to: ['ann@example.com'], subject: 'Same subject', body: `Meeting on ${day}.` }) as { message_id: string };
   await Effect.runPromise(service.mutate(card.message_id, { action: 'cancel' }));
   const receipt = await f.card(card.message_id);
   cards.push({ messageId: card.message_id, outcomeId: receipt.outcomeId });
   expect(receipt.outcomeText).toContain(`Meeting on ${day}.`);
  }
  await f.messaging.acknowledgeCardOutcomes(f.botId, cards);
  for (const card of cards) expect((await f.card(card.messageId)).outcomeEchoed).toBe(true);
  const claimed = await worker.claim(f.botId);
  expect(claimed.content).toContain('2 external message draft outcome(s)');
  for (const card of cards) {
   expect(claimed.content).toContain(`Draft card ID: ${card.messageId}`);
   expect(claimed.content).toContain(`[Card outcome ${card.outcomeId}]`);
  }
  expect(claimed.content.match(/State: dismissed/g)).toHaveLength(2);
  expect(claimed.content.match(/"subject":"Same subject"/g)).toHaveLength(2);
  expect(claimed.content).toContain('do not ask them to press Send');
  const persisted = await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: claimed.inboxId } });
  expect((persisted.payload as any).content).toBe(claimed.content);
  const hiddenMessage = await f.prisma.message.findUniqueOrThrow({ where: { id: (persisted.payload as any).messageId } });
  expect(hiddenMessage.content).toBe(claimed.content);
 } finally { await f.cleanup(); }
});

async function notificationExperiment(variant: 'control' | 'treatment') {
 const f = await fixture(`draft-ab-${variant}`);
 let mailSends = 0;
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
  return { id: `mock-mail-${++mailSends}` };
 } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
 const { WakeWorker } = await import('../../worker/src/worker');
 const worker = () => Object.assign(Object.create(WakeWorker.prototype), { prisma: f.prisma, messaging: f.messaging, workspaceRoot: f.messaging.agentData.workspaceRoot }) as any;
 const ids: string[] = [];
 const create = async (number: number) => {
  const result = await service.create(f.context(`create-${number}`), { platform: 'email', providerIdentifier: f.connection.id,
   from: 'me@example.com', to: ['ann@example.com'], subject: `AB ${number}`, body: `Synthetic draft ${number}.` }) as { message_id: string };
  ids.push(result.message_id); return result.message_id;
 };
 const settle = (id: string, action: 'send' | 'cancel') => Effect.runPromise(service.mutate(id, { action }));
 const ready = () => f.prisma.inboxEvent.updateMany({ where: { botId: f.botId, type: 'draft.response', status: 'pending' }, data: { availableAt: new Date(0) } });
 const visible = () => f.prisma.channelMessage.findMany({ where: { channelId: f.context('').channelId, senderBotId: f.botId, metadata: { path: ['type'], equals: 'text' } }, orderBy: { sequence: 'asc' } });
 const context = (runId: string, callId: string = crypto.randomUUID()) => ({ ...f.context(callId), runId });
 const release = async (claimed: any) => {
  await f.prisma.botRunLease.deleteMany({ where: { botId: f.botId } });
  await f.prisma.inboxEvent.update({ where: { id: claimed.inboxId }, data: { status: 'completed' } });
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'completed' } });
 };
 return { ...f, variant, service, worker, ids, create, settle, ready, visible, context, release, mailSends: () => mailSends };
}

test('Grokbot comparison: same-subject discard followed by reverse-order burst retains identity and accurate counts', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  const creationRun = await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } });
  for (let number = 1; number <= 6; number++) {
   const result = await f.service.create(f.context(creationRun.id, `compare-${number}`), {
    platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['draft-qa@example.com'],
    subject: number <= 2 ? 'PR-COMPARE-SAME' : `PR-COMPARE-${String(number).padStart(2, '0')}`,
    body: `Synthetic comparison card ${number}. No action required.`,
   }) as { message_id: string };
   f.ids.push(result.message_id);
  }
  await f.settle(f.ids[0]!, 'cancel'); await f.ready();
  const first = await f.worker().claim(f.botId);
  expect(first.content).toContain(`Draft card ID: ${f.ids[0]}`);
  await f.messaging.flushDraftNotification(f.context(first.runId));
  expect((await f.visible())[0]!.content).toContain('5 awaiting review');
  await f.release(first);
  // Match the native UI actions: card 1, then 6, 5, 4, 3, 2.
  for (const id of f.ids.slice(1).reverse()) await f.settle(id, 'cancel');
  await f.ready(); const second = await f.worker().claim(f.botId);
  for (const id of f.ids.slice(1)) expect(second.content).toContain(`Draft card ID: ${id}`);
  await f.messaging.flushDraftNotification(f.context(second.runId));
  await f.messaging.sendVisible(f.context(second.runId), { type: 'text', content: 'Four cards are left to review.' });
  const messages = await f.visible();
  expect(messages).toHaveLength(2);
  expect(messages[1]!.content).toContain('5 discarded without sending');
  expect(messages[1]!.content).toContain('none awaiting review');
  const covered = messages.flatMap(message => (message.metadata as any).draftOutcomeNotification.outcomeIds);
  expect(covered).toHaveLength(6); expect(new Set(covered).size).toBe(6);
  for (const id of f.ids) {
   const card = await f.card(id);
   expect(card.cardState).toBe('dismissed');
   expect(card.draftNotification.messageId).toBeString();
   expect(card.outcomeText).toContain(card.draft.body);
  }
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});

test('draft discard executes through worker dispatch and projection without a follow-up user message', async () => {
 if (!databaseUrl) return;
 const { Projection } = await import('../../worker/src/projection');
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  const dispatched: any[] = [], failures: unknown[] = [];
  let outage = false;
  const computer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
   const path = new URL(request.url).pathname;
   if (outage) return new Response('Injected computer outage', { status: 503 });
   if (path.startsWith('/v1/context-sessions/')) return Response.json({ type: 'context.state', contextSessionId: path.split('/').at(-1), epoch: 0, archives: [] });
   if (path === '/v1/task-capabilities') return Response.json({ desktopAvailable: true, boxAvailable: true });
   if (path !== '/v1/turns') return new Response(null, { status: 404 });
   const input = await request.json() as any;
   dispatched.push(input);
   // The treatment status must exist before the computer receives the turn.
   expect(await f.visible()).toHaveLength(variant === 'treatment' ? 1 : 0);
   await f.messaging.sendVisible(f.context(input.runId), { type: 'text', content: 'The three synthetic drafts were discarded.' });
   return new Response([
    { type: 'turn.started', turnId: input.runId },
    { type: 'prompt.delivered', turnId: input.runId },
    { type: 'turn.completed', turnId: input.runId, status: 'completed' },
   ].map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  try {
   await f.messaging.agentData.writeInferenceSettings({ providerId: 'openai-codex', modelId: 'synthetic-fixture', reasoning: 'low' });
   for (let i = 0; i < 3; i++) await f.settle(await f.create(i), 'cancel');
   await f.ready();
   const worker = Object.assign(f.worker(), { agentData: f.messaging.agentData, computerUrl: computer.url.origin,
    controlToken: 'synthetic-draft-test', projection: new Projection(f.prisma, f.messaging.agentData),
    pushNotifications: { drain: async () => {} } });
   const originalFail = worker.fail.bind(worker);
   worker.fail = async (...args: any[]) => { failures.push(args[1]); return originalFail(...args); };
   const claimed = await worker.claim(f.botId);
   await worker.execute(claimed);
   expect(failures).toEqual([]);
   expect(dispatched).toHaveLength(1);
   for (const id of f.ids) expect(dispatched[0].content).toContain(id);
   expect((await f.prisma.run.findUniqueOrThrow({ where: { id: claimed.runId } })).status).toBe('completed');
   expect((await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: claimed.inboxId } })).status).toBe('completed');
   expect(await f.prisma.botRunLease.count({ where: { botId: f.botId } })).toBe(0);
   expect(await f.visible()).toHaveLength(1);
   expect(await worker.claim(f.botId)).toBeNull();
   if (variant === 'treatment') {
    outage = true;
    await f.settle(await f.create(3), 'cancel'); await f.ready();
    const interrupted = await worker.claim(f.botId);
    await worker.execute(interrupted);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('Injected computer outage');
    expect(await f.visible()).toHaveLength(2);
    expect((await f.visible())[1]!.content).toContain('Nothing was sent');
    expect((await f.prisma.run.findUniqueOrThrow({ where: { id: interrupted.runId } })).status).toBe('interrupted');
    expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'ack.redrive' } })).toBe(0);
   }
   expect(f.mailSends()).toBe(0);
  } finally { computer.stop(true); await f.cleanup(); }
 }
});

test('A/B: 24 completions, lost response, new call IDs and a replayed run', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 24; i++) await f.settle(await f.create(i), 'send');
   const queued = await f.prisma.inboxEvent.findMany({ where: { botId: f.botId, status: 'pending', type: 'draft.response' } });
   expect(queued).toHaveLength(variant === 'control' ? 24 : 1);
   if (variant === 'treatment') {
    expect(queued[0]!.availableAt.getTime() - queued[0]!.createdAt.getTime()).toBeLessThanOrEqual(DRAFT_NOTIFICATION_COLLECTION_MS + 100);
    expect(queued[0]!.availableAt.getTime()).toBeGreaterThan(queued[0]!.createdAt.getTime());
   }
   await f.ready(); const claimed = await f.worker().claim(f.botId);
   const ctx = f.context(claimed.runId);
   // Same production pre-dispatch hook; ignore the result as if its response were lost.
   await f.messaging.flushDraftNotification(ctx);
   const restarted = new AgentMessaging(f.prisma, f.messaging.boss, f.messaging.agentData);
   await Promise.all([1, 2].map(i => restarted.sendVisible(f.context(claimed.runId, `retry-${i}`), { type: 'text', content: 'All 24 emails were sent.' })));
   expect(await f.visible()).toHaveLength(variant === 'control' ? 2 : 1);
   const receipts = await Promise.all(f.ids.map(async id => ({ messageId: id, outcomeId: (await f.card(id)).outcomeId })));
   await f.release(claimed);
   // Simulate a new continuation for the same outcomes, not merely a repeated tool call.
   const replay = await f.prisma.$transaction(async tx => {
    const wake = await f.messaging.enqueueWake(tx, { botId: f.botId, channelId: ctx.channelId, origin: 'user', type: 'draft.response',
     content: '[SAND_HIDDEN_PROMPT]Replay of the completed outcomes.', clientId: `replay-${crypto.randomUUID()}`, priority: 400, wrapUserContent: false });
    if (variant === 'treatment') await tx.inboxEvent.update({ where: { id: wake.inbox.id }, data: { payload: {
     ...(wake.inbox.payload as any), draftNotification: { variant: 'treatment', outcomeIds: receipts.map(row => row.outcomeId) },
    } } });
    return wake;
   });
   const replayed = await f.worker().claim(f.botId);
   if (variant === 'control') await restarted.sendVisible(f.context(replayed.runId, 'new-run-new-call'), { type: 'text', content: 'Confirmed: all 24 emails were sent.' });
   else {
    expect(replayed).toBeNull();
    expect((await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: replay.inbox.id } })).status).toBe('completed');
    for (const row of receipts) expect((await f.card(row.messageId)).draftNotification.messageId).toBe((await f.visible())[0]!.id);
   }
   const messages = await f.visible();
   expect(messages).toHaveLength(variant === 'control' ? 3 : 1);
   expect(f.mailSends()).toBe(24);
   await recordAB({ scenario: '24 completions + lost response + retries + replay', variant, outcomes: 24,
    queuedWakes: queued.length, visibleMessages: messages.length, duplicateMessages: messages.length - 1, mockedMailSends: f.mailSends() });
  } finally { await f.cleanup(); }
 }
});

test('A/B: interruption after context delivery, worker restart and a deliberately silent model', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 2; i++) await f.settle(await f.create(i), 'cancel');
   await f.ready(); const claimed = await f.worker().claim(f.botId);
   const receipts = await Promise.all(f.ids.map(async id => ({ messageId: id, outcomeId: (await f.card(id)).outcomeId })));
   await f.messaging.acknowledgeCardOutcomes(f.botId, receipts);
   if (variant === 'treatment') for (const row of receipts) {
    const card = await f.card(row.messageId);
    expect(card.draftNotification.contextDeliveredAt).toBeString();
    expect(card.draftNotification.messageId).toBeUndefined();
   }
   // Crash before visible delivery: expire the durable lease, with no in-memory recovery state.
   await f.prisma.botRunLease.updateMany({ where: { botId: f.botId }, data: { expiresAt: new Date(0) } });
   await f.prisma.inboxEvent.update({ where: { id: claimed.inboxId }, data: { claimedAt: new Date(0) } });
   const recovered = await f.worker().claim(f.botId);
   expect(recovered.runId).toBe(claimed.runId);
   await new AgentMessaging(f.prisma, f.messaging.boss, f.messaging.agentData).flushDraftNotification(f.context(recovered.runId));
   // No SendToUser call is made: deliberately inject model silence in both arms.
   expect(await f.visible()).toHaveLength(variant === 'control' ? 0 : 1);
   if (variant === 'treatment') for (const row of receipts) expect((await f.card(row.messageId)).draftNotification.notifiedAt).toBeString();
   await recordAB({ scenario: 'crash after context delivery + silent continuation', variant, outcomes: 2,
    visibleMessages: (await f.visible()).length, missingNotification: variant === 'control' ? 1 : 0 });
  } finally { await f.cleanup(); }
 }
});

test('A/B: database-derived counts, active-turn late outcomes, and no duplicate coverage', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 4; i++) await f.create(i);
   await f.settle(f.ids[0]!, 'send'); await f.settle(f.ids[1]!, 'cancel');
   await f.ready(); const first = await f.worker().claim(f.botId);
   await f.messaging.flushDraftNotification(f.context(first.runId));
   // Deliberately inject an incorrect model status in both arms. Treatment never persists it.
   await f.messaging.sendVisible(f.context(first.runId), { type: 'text', content: 'All four emails were sent. No approvals remain.' });
   if (variant === 'treatment') {
    const message = (await f.visible())[0]!;
    expect(message.content).toContain('1 sent, 1 discarded without sending');
    expect(message.content).toContain('2 awaiting review');
    expect((message.metadata as any).draftOutcomeNotification.counts).toMatchObject({ sent: 1, dismissed: 1, pending: 2 });
   }
   // The first continuation still owns its lease while the remaining outcomes arrive.
   await Promise.all(f.ids.slice(2).map(id => f.settle(id, 'send')));
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response', status: 'pending' } })).toBe(variant === 'control' ? 2 : 1);
   await f.release(first); await f.ready(); const second = await f.worker().claim(f.botId);
   await f.messaging.flushDraftNotification(f.context(second.runId));
   await f.messaging.sendVisible(f.context(second.runId), { type: 'text', content: 'All four emails were sent. No approvals remain.' });
   const messages = await f.visible();
   expect(messages).toHaveLength(2);
   if (variant === 'treatment') {
    expect(messages[1]!.content).toContain('2 sent');
    expect(messages[1]!.content).toContain('none awaiting review');
    const covered = messages.flatMap(message => (message.metadata as any).draftOutcomeNotification.outcomeIds);
    expect(covered).toHaveLength(4); expect(new Set(covered).size).toBe(4);
   }
   await recordAB({ scenario: 'late outcomes + deliberately incorrect model counts', variant, outcomes: 4,
    visibleMessages: messages.length, incorrectSummaries: messages.filter(row => row.content.startsWith('All four')).length });
  } finally { await f.cleanup(); }
 }
});

test('treatment notification, receipts and push outbox roll back together; cancellation and routing remain enforced', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 const pushUser = crypto.randomUUID();
 let deviceId: string | undefined;
 try {
  await f.settle(await f.create(0), 'cancel'); await f.ready(); const claimed = await f.worker().claim(f.botId);
  const context = { ...f.context(claimed.runId), timeZone: 'UTC' };
  await f.prisma.user.create({ data: { id: pushUser, name: 'Draft notification AB fixture', email: `${pushUser}@openteam.invalid` } });
  const session = await f.prisma.session.create({ data: { id: crypto.randomUUID(), userId: pushUser, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const device = await f.prisma.pushDevice.create({ data: { installationId: crypto.randomUUID(), platform: 'ios',
   pushToken: crypto.randomUUID(), authSessionId: session.id, authRequired: process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() !== 'disabled' } });
  deviceId = device.id;
  const originalNotifications = await f.prisma.channelNotification.count({ where: { channelId: context.channelId } });
  await expect(f.prisma.$transaction(async tx => {
   expect((await publishDraftNotification(tx, context))?.created).toBe(true);
   expect(await tx.outboxDelivery.count({ where: { target: device.id } })).toBe(1);
   throw new Error('injected crash before commit');
  })).rejects.toThrow('injected crash before commit');
  expect(await f.visible()).toHaveLength(0);
  expect((await f.card(f.ids[0]!)).draftNotification.messageId).toBeUndefined();
  expect(await f.prisma.channelNotification.count({ where: { channelId: context.channelId } })).toBe(originalNotifications);
  expect(await f.prisma.outboxDelivery.count({ where: { target: device.id } })).toBe(0);
  expect(await f.messaging.flushDraftNotification({ ...context, channelId: crypto.randomUUID() })).toBeNull();
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'cancelled' } });
  expect((await f.messaging.flushDraftNotification(context))?.acknowledgement).toMatchObject({ sent: false, silent: true });
  expect(await f.visible()).toHaveLength(0);
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'running' } });
  await Promise.all(Array.from({ length: 3 }, () => f.messaging.flushDraftNotification(context)));
  expect(await f.visible()).toHaveLength(1);
  expect(await f.prisma.channelNotification.count({ where: { channelId: context.channelId } })).toBe(originalNotifications + 1);
  expect(await f.prisma.outboxDelivery.count({ where: { target: device.id } })).toBe(1);
  // A real user reply is not replaced or deduplicated by the notification experiment.
  await f.release(claimed);
  const replay = await f.prisma.$transaction(async tx => {
   const wake = await f.messaging.enqueueWake(tx, { botId: f.botId, channelId: context.channelId, origin: 'user', type: 'draft.response',
    content: '[SAND_HIDDEN_PROMPT]Already reported outcome.', clientId: `already-${crypto.randomUUID()}`, priority: 400, wrapUserContent: false });
   await tx.inboxEvent.update({ where: { id: wake.inbox.id }, data: { payload: { ...(wake.inbox.payload as any), draftNotification: { variant: 'treatment' } } } });
   await f.messaging.enqueueWake(tx, { botId: f.botId, channelId: context.channelId, origin: 'user', type: 'user.message',
    content: 'A new real user request.', clientId: `user-${crypto.randomUUID()}`, priority: 400 });
   return wake;
  });
  const userClaim = await f.worker().claim(f.botId);
  expect(userClaim.inboxType).toBe('user.message');
  expect((await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: replay.inbox.id } })).status).toBe('completed');
  await f.messaging.sendVisible(f.context(userClaim.runId), { type: 'text', content: 'A normal answer to a new user request.' });
  expect((await f.visible()).at(-1)!.content).toBe('A normal answer to a new user request.');
 } finally {
  if (deviceId) { await f.prisma.outboxDelivery.deleteMany({ where: { target: deviceId } }); await f.prisma.pushDevice.deleteMany({ where: { id: deviceId } }); }
  await f.prisma.user.deleteMany({ where: { id: pushUser } });
  await f.cleanup();
 }
});

test('a pending treatment replay that absorbs a new outcome reports the new outcome exactly once', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  const oldCard = await f.create(0); await f.settle(oldCard, 'cancel'); await f.ready();
  const first = await f.worker().claim(f.botId);
  await f.messaging.flushDraftNotification(f.context(first.runId)); await f.release(first);
  const oldOutcome = (await f.card(oldCard)).outcomeId;
  const replay = await f.prisma.$transaction(async tx => {
   const wake = await f.messaging.enqueueWake(tx, { botId: f.botId, channelId: f.context('').channelId, origin: 'user', type: 'draft.response',
    content: '[SAND_HIDDEN_PROMPT]Replay of an already reported outcome.', clientId: `replay-late-${crypto.randomUUID()}`, priority: 400, wrapUserContent: false });
   await tx.inboxEvent.update({ where: { id: wake.inbox.id }, data: { payload: { ...(wake.inbox.payload as any),
    draftNotification: { variant: 'treatment', outcomeIds: [oldOutcome] } } } });
   return wake;
  });
  const newCard = await f.create(1); await f.settle(newCard, 'cancel'); await f.ready();
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response', status: 'pending' } })).toBe(1);
  const claimed = await f.worker().claim(f.botId);
  expect(claimed.runId).toBe(replay.run.id);
  await f.messaging.flushDraftNotification(f.context(claimed.runId));
  await f.messaging.flushDraftNotification(f.context(claimed.runId, 'lost-response-retry'));
  const messages = await f.visible();
  expect(messages).toHaveLength(2);
  expect((messages[1]!.metadata as any).draftOutcomeNotification.outcomeIds).toEqual([(await f.card(newCard)).outcomeId]);
  expect((await f.card(oldCard)).draftNotification.messageId).toBe(messages[0]!.id);
  expect((await f.card(newCard)).draftNotification.messageId).toBe(messages[1]!.id);
 } finally { await f.cleanup(); }
});

test('the approval menu lets a Bot email allowed recipients, or everyone, without a card', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-approval');
 const calls: any[] = [];
 const plugins = { invoke: async (input: any) => { calls.push(input); return input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: 'sent' }; } };
 const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never);
 const sends = () => calls.filter((call) => call.arguments.action === 'send').length;
 try {
  const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Hello', body: 'Hi Ann' };
  const first = await service.create(f.context('approval-a'), draft) as { message_id: string };
  // Unsent recipient edits on the card decide what the rule allows.
  await Effect.runPromise(service.mutate(first.message_id, { action: 'approval', mode: 'always-allow', edits: { body: 'Hi Ann', subject: 'Hello', to: ['Ann@Example.com', 'bob@example.com'], cc: [] } }));
  expect((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).draftAllowedRecipients).toEqual(['ann@example.com', 'bob@example.com']);
  expect(await f.prisma.event.count({ where: { topic: 'bot.updated', entityId: f.botId } })).toBeGreaterThan(0);
  expect(sends()).toBe(0);

  const allowed = await service.create(f.context('approval-b'), draft) as Record<string, any>;
  expect(allowed).toMatchObject({ delivery: 'sent' });
  expect(allowed.note).toBe("The user allowed ann@example.com for you, so it skipped the review card. Don't send it again.");
  expect(sends()).toBe(1);
  expect(await f.card(allowed.message_id)).toMatchObject({ cardState: 'sent', sentUnder: { rule: 'Allow recipient ann@example.com' }, outcomeEchoed: true });
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);

  // "Let me see it first" keeps the card waiting even for an allowed recipient.
  const reviewFirst = await service.create(f.context('approval-r'), { ...draft, waitForReview: true }) as Record<string, any>;
  expect(reviewFirst.delivery).toBeUndefined();
  expect((await f.card(reviewFirst.message_id)).cardState).toBeUndefined();
  expect(sends()).toBe(1);
  const mixed = await service.create(f.context('approval-c'), { ...draft, cc: ['carol@example.com'] }) as Record<string, any>;
  expect(mixed.delivery).toBeUndefined();
  expect(sends()).toBe(1);

  await Effect.runPromise(service.mutate(allowed.message_id, { action: 'approval', mode: 'needs-approval' }));
  expect((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).draftAllowedRecipients).toEqual(['bob@example.com']);
  const reviewed = await service.create(f.context('approval-d'), draft) as Record<string, any>;
  expect(reviewed.delivery).toBeUndefined();

  await Effect.runPromise(service.mutate(reviewed.message_id, { action: 'approval', mode: 'disable-drafts' }));
  const anyone = await service.create(f.context('approval-e'), { ...draft, to: ['dave@example.com'] }) as Record<string, any>;
  expect(anyone).toMatchObject({ delivery: 'sent' });
  expect(anyone.note).toContain('Your drafts are off');
  expect(await f.card(anyone.message_id)).toMatchObject({ cardState: 'sent', sentUnder: { draftingDisabled: true } });
  expect(sends()).toBe(2);
  // A replayed tool call returns the original card without sending twice.
  await service.create(f.context('approval-e'), { ...draft, to: ['dave@example.com'] });
  expect(sends()).toBe(2);

  await Effect.runPromise(service.mutate(anyone.message_id, { action: 'approval', mode: 'needs-approval' }));
  // Turning review back on keeps the recipient rules the user made earlier.
  expect(await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId }, select: { draftingDisabled: true, draftAllowedRecipients: true } })).toEqual({ draftingDisabled: false, draftAllowedRecipients: ['bob@example.com'] });
  await expect(Effect.runPromise(service.mutate(anyone.message_id, { action: 'approval', mode: 'sometimes' }))).rejects.toThrow('Choose always-allow');
 } finally { await f.cleanup(); }
});

test('a draft made in a room becomes a card in the 1:1 chat', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-room');
 const plugins = { invoke: async (input: any) => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: 'sent' } };
 const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never);
 const room = await f.prisma.channel.create({ data: { kind: 'group', name: 'Room', members: { create: { botId: f.botId, ordinal: 0 } } } });
 try {
  const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Hello', body: 'Hi Ann' };
  const card = await service.create({ ...f.context('room-draft'), channelId: room.id }, draft) as Record<string, any>;
  expect(card).toMatchObject({ in_dm: true });
  const message = await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: card.message_id } });
  expect(message.channelId).not.toBe(room.id);
  expect((await f.prisma.channel.findUniqueOrThrow({ where: { id: message.channelId } })).kind).toBe('bot_dm');
  const { renderControlResult } = await import('@openteam/contracts/tool-results');
  expect(renderControlResult('DraftExternalMessage', card, draft)).toBe(
   `Draft email from me@example.com to ann@example.com is now an editable card in your own 1:1 chat with the user, not in this room (a room cannot hold draft cards); tell the room where it is (id: ${card.message_id}). Nothing has been sent; the user reviews, may edit, and sends or discards it from the card.`
  );
 } finally { await f.prisma.channel.deleteMany({ where: { id: room.id } }); await f.cleanup(); }
});
