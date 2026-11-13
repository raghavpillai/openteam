import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging, publishDraftNotification, DRAFT_NOTIFICATION_COLLECTION_MS } from '@openteam/messaging';
import { Effect } from 'effect';
import { ExternalDraftService } from '../src/services/external-draft-service';
import { RunService } from '../src/services/run-service';
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
  // Both racing sends must see the saved review edits; lock acquisition order is unspecified.
  await Effect.runPromise(service.mutate(card.message_id, { action: 'save', edits: { from: 'alias@example.com', body: 'It is $1,250. Thanks!', to: ['ann@example.com'], cc: ['bob@example.com'] } }));
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
  expect(claimed.content).toContain('The platform handles the status acknowledgement');
  for (const card of cards) {
   expect(claimed.content).toContain(`Draft card ID: ${card.messageId}`);
   expect(claimed.content).toContain(card.outcomeId);
  }
  expect(claimed.content.match(/state: dismissed/g)).toHaveLength(2);
  expect(claimed.content).toContain('individual card outcomes');
  expect(claimed.content).toContain('Do not post another status confirmation');
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
 const worker = () => Object.assign(Object.create(WakeWorker.prototype), { prisma: f.prisma, messaging: f.messaging, workspaceRoot: f.messaging.agentData.workspaceRoot, memoryReviews: new Map() }) as any;
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
  await f.messaging.sendVisible(f.context(second.runId), { type: 'text', content: (await f.visible())[0]!.content });
  const messages = await f.visible();
  expect(messages).toHaveLength(1);
  expect(messages[0]!.content).toContain('6 discarded without sending');
  expect(messages[0]!.content).toContain('none awaiting review');
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
   expect(await f.visible()).toHaveLength(1);
   expect(input.requestSource).toBe('event');
   {
    expect(input.draftStatusAcknowledged).toBe(true);
    expect(input.content).toContain((await f.visible())[0]!.content);
    expect(input.content).toContain('Current draft state at dispatch:');
    expect(input.content).toContain('\"pending\":0');
    expect(input.draftStateRevision).toMatch(/^[a-f0-9]{64}$/);
   }
   // Match the real computer: accept the stream before any model tool runs.
   return new Response(new ReadableStream({ start(controller) {
    const write = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    write({ type: 'turn.started', turnId: input.runId });
    void (async () => {
     // An acknowledged event may finish silently; ordinary turns still owe a reply.
     // The durable status already exists; a status-only continuation finishes silently.
     write({ type: 'prompt.delivered', turnId: input.runId });
     write({ type: 'turn.completed', turnId: input.runId, status: 'completed' }); controller.close();
    })().catch(error => controller.error(error));
   } }), { headers: { 'content-type': 'application/x-ndjson' } });
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
   await Promise.all([1, 2].map(i => restarted.sendVisible(f.context(claimed.runId, `retry-${i}`), { type: 'text', content: '24 email drafts settled: 24 sent. Drafts in this chat: none awaiting review.' })));
   expect(await f.visible()).toHaveLength(1);
   const receipts = await Promise.all(f.ids.map(async id => ({ messageId: id, outcomeId: (await f.card(id)).outcomeId })));
   await f.release(claimed);
   // Simulate a new continuation for the same outcomes, not merely a repeated tool call.
   const replay = await f.prisma.$transaction(async tx => {
    const wake = await f.messaging.enqueueWake(tx, { botId: f.botId, channelId: ctx.channelId, origin: 'user', type: 'draft.response',
     content: '[SAND_HIDDEN_PROMPT]Replay of the completed outcomes.', clientId: `replay-${crypto.randomUUID()}`, priority: 400, wrapUserContent: false });
    await tx.inboxEvent.update({ where: { id: wake.inbox.id }, data: { payload: {
     ...(wake.inbox.payload as any), draftNotification: { variant, outcomeIds: receipts.map(row => row.outcomeId) },
    } } });
    return wake;
   });
   const replayed = await f.worker().claim(f.botId);
   {
    expect(replayed).toBeNull();
    expect((await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: replay.inbox.id } })).status).toBe('completed');
    for (const row of receipts) expect((await f.card(row.messageId)).draftNotification.messageId).toBe((await f.visible())[0]!.id);
   }
   const messages = await f.visible();
   expect(messages).toHaveLength(1);
   expect(f.mailSends()).toBe(24);
   await recordAB({ scenario: '24 completions + lost response + retries + replay', variant, outcomes: 24,
    queuedWakes: queued.length, visibleMessages: messages.length, duplicateMessages: messages.length - 1, mockedMailSends: f.mailSends() });
  } finally { await f.cleanup(); }
 }
}, 15_000);

test('A/B: interruption after context delivery, worker restart and a deliberately silent model', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 2; i++) await f.settle(await f.create(i), 'cancel');
   await f.ready(); const claimed = await f.worker().claim(f.botId);
   const receipts = await Promise.all(f.ids.map(async id => ({ messageId: id, outcomeId: (await f.card(id)).outcomeId })));
   await f.messaging.acknowledgeCardOutcomes(f.botId, receipts);
   for (const row of receipts) {
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
   expect(await f.visible()).toHaveLength(1);
   for (const row of receipts) expect((await f.card(row.messageId)).draftNotification.notifiedAt).toBeString();
   await recordAB({ scenario: 'crash after context delivery + silent continuation', variant, outcomes: 2,
    visibleMessages: (await f.visible()).length, missingNotification: 0 });
  } finally { await f.cleanup(); }
 }
});

test('A/B: canonical counts stay accurate while independent model text retains its actual content and receipt', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 4; i++) await f.create(i);
   await f.settle(f.ids[0]!, 'send'); await f.settle(f.ids[1]!, 'cancel');
   await f.ready(); const first = await f.worker().claim(f.botId);
   await f.messaging.flushDraftNotification(f.context(first.runId));
   // Arbitrary model prose is not a semantic status filter. Only the platform's
   // own notification is database-derived; never claim other text was delivered in its place.
   await f.messaging.sendVisible(f.context(first.runId), { type: 'text', content: 'All four emails were sent. No approvals remain.' });
   {
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
   expect(messages).toHaveLength(4);
   {
    const notifications = messages.filter(message => (message.metadata as any).draftOutcomeNotification);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.content).toContain('2 sent');
    expect(notifications[1]!.content).toContain('none awaiting review');
    const covered = notifications.flatMap(message => (message.metadata as any).draftOutcomeNotification.outcomeIds);
    expect(covered).toHaveLength(4); expect(new Set(covered).size).toBe(4);
   }
   await recordAB({ scenario: 'late outcomes + deliberately incorrect model counts', variant, outcomes: 4,
    visibleMessages: messages.length, incorrectSummaries: messages.filter(row => row.content.startsWith('All four')).length });
  } finally { await f.cleanup(); }
 }
});

test('treatment delivers follow-up questions, mixed text and warnings with their own truthful receipts', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  for (let i = 0; i < 3; i++) await f.create(i);
  await f.settle(f.ids[0]!, 'cancel'); await f.ready();
  const claimed = await f.worker().claim(f.botId);
  await f.messaging.flushDraftNotification(f.context(claimed.runId));
  const canonical = (await f.visible())[0]!;
  const echoed = await f.messaging.sendVisible(f.context(claimed.runId), { type: 'text', content: canonical.content });
  expect(echoed.acknowledgement).toMatchObject({ sent: true, message_id: canonical.id, duplicate: true });
  expect(await f.visible()).toHaveLength(1);
  const texts = [
   'Would you like revisions to the remaining drafts?',
   'Disk space is low. Please pause large downloads.',
   'Please choose which remaining draft to revise.',
   canonical.content + '\nWould you like revisions?',
  ];
  for (const content of texts) {
   const context = f.context(claimed.runId);
   const receipt = await f.messaging.sendVisible(context, { type: 'text', content });
   if (typeof receipt.acknowledgement === 'string') throw new Error('Expected a message receipt');
   expect(receipt.acknowledgement.sent).toBe(true);
   const messageId = String(receipt.acknowledgement.message_id);
   expect(messageId).not.toBe(canonical.id);
   const message = await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
   expect(message.content).toBe(content);
   expect((message.metadata as any).draftOutcomeNotification).toBeUndefined();
   const retried = await f.messaging.sendVisible(context, { type: 'text', content });
   expect(retried.acknowledgement).toMatchObject({ sent: true, message_id: message.id, duplicate: true });
  }
  const reply = await f.messaging.sendVisible(f.context(claimed.runId), { type: 'text', content: canonical.content, reply_to: (canonical.metadata as any).address });
  if (typeof reply.acknowledgement === 'string') throw new Error('Expected a reply receipt');
  const replyId = String(reply.acknowledgement.message_id);
  expect(replyId).not.toBe(canonical.id);
  const replyMessage = await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: replyId } });
  expect((replyMessage.metadata as any).replyTo).toBe(canonical.id);
  expect(await f.visible()).toHaveLength(6);
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'cancelled' } });
  const cancelled = await f.messaging.sendVisible(f.context(claimed.runId), { type: 'text', content: 'A late cancelled warning.' });
  expect(cancelled.acknowledgement).toMatchObject({ sent: false, silent: true });
  expect(await f.visible()).toHaveLength(6);
 } finally { await f.cleanup(); }
});

test('treatment notification, receipts and push outbox roll back together; cancellation and routing remain enforced', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 const pushUser = crypto.randomUUID();
 let deviceId: string | undefined;
 try {
  const firstCard = await f.create(0), secondCard = await f.create(1);
  await f.settle(firstCard, 'cancel'); await f.ready(); const claimed = await f.worker().claim(f.botId);
  const context = { ...f.context(claimed.runId), timeZone: 'UTC' };
  await f.prisma.user.create({ data: { id: pushUser, name: 'Draft notification AB fixture', email: `${pushUser}@openteam.invalid` } });
  const session = await f.prisma.session.create({ data: { id: crypto.randomUUID(), userId: pushUser, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const device = await f.prisma.pushDevice.create({ data: { installationId: crypto.randomUUID(), platform: 'ios',
   pushToken: crypto.randomUUID(), authSessionId: session.id, authRequired: process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() !== 'disabled' } });
  deviceId = device.id;
  const deliveryWhere = { target: device.id, payload: { path: ['channelId'], equals: context.channelId } };
  const originalNotifications = await f.prisma.channelNotification.count({ where: { channelId: context.channelId } });
  await expect(f.prisma.$transaction(async tx => {
   expect((await publishDraftNotification(tx, context))?.created).toBe(true);
   expect(await tx.outboxDelivery.count({ where: deliveryWhere })).toBe(1);
   throw new Error('injected crash before commit');
  })).rejects.toThrow('injected crash before commit');
  expect(await f.visible()).toHaveLength(0);
  expect((await f.card(f.ids[0]!)).draftNotification.messageId).toBeUndefined();
  expect(await f.prisma.channelNotification.count({ where: { channelId: context.channelId } })).toBe(originalNotifications);
  expect(await f.prisma.outboxDelivery.count({ where: deliveryWhere })).toBe(0);
  expect(await f.messaging.flushDraftNotification({ ...context, channelId: crypto.randomUUID() })).toBeNull();
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'cancelled' } });
  expect((await f.messaging.flushDraftNotification(context))?.acknowledgement).toMatchObject({ sent: false, silent: true });
  expect(await f.visible()).toHaveLength(0);
  await f.prisma.run.update({ where: { id: claimed.runId }, data: { status: 'running' } });
  await Promise.all(Array.from({ length: 3 }, () => f.messaging.flushDraftNotification(context)));
  expect(await f.visible()).toHaveLength(1);
  expect(await f.prisma.channelNotification.count({ where: { channelId: context.channelId } })).toBe(originalNotifications + 1);
  expect(await f.prisma.outboxDelivery.count({ where: deliveryWhere })).toBe(1);
  // Updating progress is atomic with its new receipts and the already queued push body.
  const oldProgress = (await f.visible())[0]!;
  await f.release(claimed); await f.settle(secondCard, 'cancel'); await f.ready();
  const secondClaim = await f.worker().claim(f.botId);
  await expect(f.prisma.$transaction(async tx => {
   expect((await publishDraftNotification(tx, f.context(secondClaim.runId)))?.updated).toBe(true);
   throw new Error('crash while updating progress');
  })).rejects.toThrow('crash while updating progress');
  expect((await f.visible())[0]!.content).toBe(oldProgress.content);
  expect((await f.card(secondCard)).draftNotification.messageId).toBeUndefined();
  expect(((await f.prisma.outboxDelivery.findFirstOrThrow({ where: deliveryWhere })).payload as any).body).toBe(oldProgress.content);
  await f.messaging.flushDraftNotification(f.context(secondClaim.runId));
  const updatedProgress = (await f.visible())[0]!;
  expect(updatedProgress.id).toBe(oldProgress.id);
  expect(updatedProgress.content).toContain('2 discarded without sending');
  expect(updatedProgress.content).toContain('none awaiting review');
  expect(((await f.prisma.outboxDelivery.findFirstOrThrow({ where: deliveryWhere })).payload as any).body).toBe(updatedProgress.content);
  expect(((await f.prisma.channelNotification.findUniqueOrThrow({ where: { key: `message:${updatedProgress.id}` } })).payload as any).body).toBe(updatedProgress.content);
  expect(await f.prisma.outboxDelivery.count({ where: deliveryWhere })).toBe(1);
  expect(await f.prisma.channelNotification.count({ where: { channelId: context.channelId } })).toBe(originalNotifications + 1);
  await f.release(secondClaim);
  // A real user reply is not replaced or deduplicated by the notification experiment.

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

test('a changed draft snapshot rejects old questions and sibling warnings with truthful retryable receipts', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   for (let i = 0; i < 3; i++) await f.create(i);
   await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const claimed = await f.worker().claim(f.botId);
   await f.messaging.flushDraftNotification(f.context(claimed.runId));
   const snapshot = await f.messaging.draftReplySnapshot(f.context(claimed.runId));
   expect(snapshot.counts.pending).toBe(2);
   const old = { ...f.context(claimed.runId, 'old-question'), draftStateRevision: snapshot.revision };
   await Promise.all(f.ids.slice(1).map(id => f.settle(id, 'cancel')));
   const before = (await f.visible()).length;
   const rejected = await f.messaging.sendVisible(old, { type: 'text', content: 'Would you like revisions to the remaining drafts?', end_turn: true });
   expect(rejected.acknowledgement).toMatchObject({ sent: false, delivery_failed: true, retryable: true, reason: 'draft_state_changed', draft_state: { pending: 0 } });
   expect(await f.visible()).toHaveLength(before);
   const widget = await f.messaging.sendVisible({ ...old, callId: 'old-widget' }, { type: 'widget', widget: {
    prompt: 'Would you like revisions to the remaining drafts?', options: [{ label: 'Revise', value: 'revise' }],
   } });
   expect(widget.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed', draft_state: { pending: 0 } });
   expect(await f.prisma.channelMessage.count({ where: { channelId: old.channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
   // An already-emitted sibling does not acquire the fresh state merely because another call was rejected.
   const warning = 'Disk check failed. Please pause large downloads.';
   const sibling = await f.messaging.sendVisible({ ...old, callId: 'old-warning' }, { type: 'text', content: warning });
   expect(sibling.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed' });
   const fresh = { ...f.context(claimed.runId, 'fresh-warning'), draftStateRevision: (rejected.acknowledgement as any).draft_state_revision };
   const delivered = await f.messaging.sendVisible(fresh, { type: 'text', content: warning });
   expect(delivered.acknowledgement).toMatchObject({ sent: true });
   const message = await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: (delivered.acknowledgement as any).message_id } });
   expect(message.content).toBe(warning);
   // A lost success response keeps its own receipt even after the state changes again.
   await f.create(3);
   expect((await f.messaging.sendVisible(fresh, { type: 'text', content: warning })).acknowledgement)
    .toMatchObject({ sent: true, duplicate: true, message_id: message.id });
   expect((await f.visible()).filter(m => m.content.includes('Would you like revisions'))).toHaveLength(0);
   expect(f.mailSends()).toBe(0);
  } finally { await f.cleanup(); }
 }
});

test('consecutive draft batches update one progress row and preserve per-outcome receipts across retries', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  for (let i = 0; i < 24; i++) await f.create(i);
  const notificationsBefore = await f.prisma.channelNotification.count({ where: { channelId: f.context('').channelId } });
  let progressId = '';
  for (let offset = 0; offset < 24; offset += 3) {
   await Promise.all(f.ids.slice(offset, offset + 3).map(id => f.settle(id, 'cancel'))); await f.ready();
   const claimed = await f.worker().claim(f.botId);
   const receipt = await f.messaging.flushDraftNotification(f.context(claimed.runId));
   const id = String((receipt?.acknowledgement as any).message_id);
   if (!progressId) progressId = id;
   expect(id).toBe(progressId);
   expect((await f.messaging.flushDraftNotification(f.context(claimed.runId)))?.acknowledgement).toMatchObject({ message_id: id, duplicate: true });
   await f.release(claimed);
  }
  const messages = await f.visible(); expect(messages).toHaveLength(1);
  expect(messages[0]!.content).toContain('24 discarded without sending');
  expect(messages[0]!.content).toContain('none awaiting review');
  const covered = (messages[0]!.metadata as any).draftOutcomeNotification.outcomeIds;
  expect(covered.length).toBe(24); expect(new Set(covered).size).toBe(24);
  for (const id of f.ids) expect((await f.card(id)).draftNotification.messageId).toBe(progressId);
  expect(await f.prisma.channelNotification.count({ where: { channelId: f.context('').channelId } })).toBe(notificationsBefore + 1);
  expect(await f.prisma.event.count({ where: { topic: 'channel.message.updated', entityId: progressId } })).toBe(7);
  expect(await f.worker().claim(f.botId)).toBeNull(); expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
}, 15_000);

test('progress acknowledgements start a fresh row after other chat messages, idle pauses, or a completed batch', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  for (let i = 0; i < 5; i++) await f.create(i);
  const publish = async (id: string) => {
   await f.settle(id, 'cancel'); await f.ready(); const claimed = await f.worker().claim(f.botId);
   await f.messaging.flushDraftNotification(f.context(claimed.runId)); await f.release(claimed);
  };
  await publish(f.ids[0]!);
  await f.prisma.channelMessage.create({ data: { channelId: f.context('').channelId, sender: 'user', content: 'A new request.', clientId: crypto.randomUUID() } });
  await publish(f.ids[1]!); expect(await f.visible()).toHaveLength(2);
  const last = (await f.visible()).at(-1)!;
  await f.prisma.channelMessage.update({ where: { id: last.id }, data: { metadata: { ...(last.metadata as any), draftOutcomeNotification: {
   ...(last.metadata as any).draftOutcomeNotification, updatedAt: new Date(Date.now() - 11_000).toISOString(),
  } } } });
  await publish(f.ids[2]!); expect(await f.visible()).toHaveLength(3);
  await f.messaging.sendVisible(f.context((await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id), { type: 'text', content: 'An unrelated warning.' });
  await publish(f.ids[3]!); expect(await f.visible()).toHaveLength(5);
  await publish(f.ids[4]!); expect(await f.visible()).toHaveLength(5);
  await publish(await f.create(5)); expect(await f.visible()).toHaveLength(6);
 } finally { await f.cleanup(); }
});

test('a change during platform-context preparation cannot authorize a reply based on the old context', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 const { Projection } = await import('../../worker/src/projection');
 const failures: unknown[] = []; let dispatched = false;
 const computer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/v1/context-sessions/')) return Response.json({ type: 'context.state', contextSessionId: path.split('/').at(-1), epoch: 0, archives: [] });
  if (path === '/v1/task-capabilities') return Response.json({ desktopAvailable: false, boxAvailable: true });
  const input = await request.json() as any; dispatched = true;
  // The real computer returns streaming headers before model tools run. Dispatch
  // holds the run row until those headers arrive, so do not await a tool here.
  return new Response(new ReadableStream({ start(controller) {
   const write = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
   write({ type: 'turn.started', turnId: input.runId });
   void (async () => {
    const rejected = await f.messaging.sendVisible({ ...f.context(input.runId), draftStateRevision: input.draftStateRevision },
     { type: 'text', content: 'Would you like revisions to the remaining drafts?', end_turn: true });
    expect(rejected.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed', draft_state: { pending: 0 } });
    write({ type: 'prompt.delivered', turnId: input.runId });
    write({ type: 'turn.completed', turnId: input.runId, status: 'completed' }); controller.close();
   })().catch(error => controller.error(error));
  } }), { headers: { 'content-type': 'application/x-ndjson' } });
 } });
 try {
  for (let i = 0; i < 3; i++) await f.create(i);
  await f.messaging.agentData.writeInferenceSettings({ providerId: 'openai-codex', modelId: 'synthetic-fixture', reasoning: 'low' });
  await f.settle(f.ids[0]!, 'cancel'); await f.ready();
  const original = f.messaging.platformPrompt.bind(f.messaging);
  f.messaging.platformPrompt = async (...args: Parameters<typeof original>) => {
   const prompt = await original(...args);
   await Promise.all(f.ids.slice(1).map(id => f.settle(id, 'cancel')));
   return prompt;
  };
  const worker = Object.assign(f.worker(), { agentData: f.messaging.agentData, computerUrl: computer.url.origin,
   controlToken: 'synthetic', projection: new Projection(f.prisma, f.messaging.agentData), pushNotifications: { drain: async () => {} } });
  const originalFail = worker.fail.bind(worker);
  worker.fail = async (...args: any[]) => { failures.push(args[1]); return originalFail(...args); };
  const claimed = await worker.claim(f.botId); await worker.execute(claimed);
  expect(failures).toEqual([]); expect(dispatched).toBe(true);
  expect((await f.visible()).some(m => m.content.includes('Would you like revisions'))).toBe(false);
  expect(f.mailSends()).toBe(0);
 } finally { computer.stop(true); await f.cleanup(); }
});

test('a refreshed question widget still delivers when draft identities change but cards remain', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  for (let i = 0; i < 3; i++) await f.create(i);
  await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const claimed = await f.worker().claim(f.botId);
  const snapshot = await f.messaging.draftReplySnapshot(f.context(claimed.runId));
  await f.settle(f.ids[1]!, 'cancel'); await f.create(3);
  const question = { type: 'widget' as const, widget: { prompt: 'Which remaining draft should I revise?', options: [{ label: 'Choose a draft', value: 'choose' }] } };
  const old = await f.messaging.sendVisible({ ...f.context(claimed.runId), draftStateRevision: snapshot.revision }, question);
  expect(old.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed', draft_state: { pending: 2 } });
  const context = { ...f.context(claimed.runId), draftStateRevision: (old.acknowledgement as any).draft_state_revision };
  const delivered = await f.messaging.sendVisible(context, question);
  expect(delivered.acknowledgement).toMatchObject({ sent: true });
  const message = await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: (delivered.acknowledgement as any).message_id } });
  expect(message.content).toBe(question.widget.prompt);
  expect((message.metadata as any).type).toBe('widget');
  const retried = await f.messaging.sendVisible(context, question);
  expect(retried.acknowledgement).toMatchObject({ sent: true, duplicate: true, message_id: message.id });
  expect(await f.prisma.channelMessage.count({ where: { channelId: context.channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(1);
 } finally { await f.cleanup(); }
});


/** Observe an actual blocked query, rather than assuming a fixed scheduling delay. */
async function waitForDraftLockWaiter(prisma: ReturnType<typeof createPrismaClient>, key: string) {
 const deadline = Date.now() + 8_000;
 while (Date.now() < deadline) {
  const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND objid = (hashtext(${key})::bigint & 4294967295)::oid AND NOT granted) AS waiting`;
  if (rows[0]?.waiting) return;
  await Bun.sleep(10);
 }
 throw new Error('Draft operation never reached the held lock');
}

test('cancellation while waiting on the draft lock blocks both status and question publication', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) for (const type of ['text', 'widget'] as const) {
  const f = await notificationExperiment(variant);
  let unlock: () => void = () => {}, locked: () => void = () => {};
  const held = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => unlock = resolve);
  let barrier: Promise<unknown> | undefined;
  try {
   for (let i = 0; i < 2; i++) await f.create(i);
   await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId);
   const context = f.context(turn.runId), snapshot = await f.messaging.draftReplySnapshot(context);
   const key = `draft-notification:${f.botId}:${context.channelId}`;
   barrier = f.prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`; locked(); await gate;
   }, { timeout: 15_000 });
   await held;
   const reply = f.messaging.sendVisible({ ...context, draftStateRevision: snapshot.revision }, type === 'text'
    ? { type, content: 'A late draft confirmation.' }
    : { type, widget: { prompt: 'Revise the remaining draft?', options: [{ label: 'Revise', value: 'revise' }] } });
   await waitForDraftLockWaiter(f.prisma, key);
   await f.prisma.run.update({ where: { id: turn.runId }, data: { status: 'cancelled' } });
   unlock(); await barrier;
   expect((await reply).acknowledgement).toMatchObject(type === 'text'
    ? { sent: false, silent: true } : { sent: false, retryable: false, reason: 'turn_not_active' });
   expect(await f.visible()).toHaveLength(0);
   expect(await f.prisma.channelMessage.count({ where: { channelId: context.channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
   expect((await f.card(f.ids[0]!)).draftNotification?.messageId).toBeUndefined();
  } finally { unlock(); await barrier?.catch(() => {}); await f.cleanup(); }
 }
}, 30_000);

test('racing send and discard settle each card exactly once and repeated actions cannot resend', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   let expectedSends = 0;
   for (let i = 0; i < 16; i++) {
    const id = await f.create(i), before = f.mailSends();
    const actions = i % 2 ? ['send', 'cancel'] as const : ['cancel', 'send'] as const;
    await Promise.all(actions.map(action => f.settle(id, action)));
    const metadata = await f.card(id);
    expect(['sent', 'dismissed']).toContain(metadata.cardState);
    expectedSends += metadata.cardState === 'sent' ? 1 : 0;
    expect(f.mailSends() - before).toBe(metadata.cardState === 'sent' ? 1 : 0);
    const receipt = metadata.outcomeId;
    await Promise.all([f.settle(id, 'send'), f.settle(id, 'cancel'), f.settle(id, 'send')]);
    expect((await f.card(id)).outcomeId).toBe(receipt);
    expect(f.mailSends()).toBe(expectedSends);
   }
   const cards = await Promise.all(f.ids.map(id => f.card(id)));
   expect(new Set(cards.map(card => card.outcomeId)).size).toBe(16);
   const snapshot = await f.messaging.draftReplySnapshot(f.context(''));
   expect(snapshot.counts).toMatchObject({ pending: 0, sending: 0, sent: expectedSends, dismissed: 16 - expectedSends });
  } finally { await f.cleanup(); }
 }
}, 30_000);

test('failed verification reopens review without sending or producing a settled-outcome wake', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 let failVerification = false, entered: () => void = () => {}, release: () => void = () => {}, sends = 0;
 const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  if (input.arguments.action === 'verify') {
   if (failVerification) { entered(); await gate; throw new Error('Synthetic verification unavailable'); }
   return { identity: 'me@example.com' };
  }
  sends++; return { id: 'synthetic-send' };
 } } as never, { treatmentPercent: '100' });
 let sending: Promise<unknown> | undefined;
 try {
  for (let i = 0; i < 3; i++) await f.create(i);
  await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId);
  failVerification = true; sending = Effect.runPromise(service.mutate(f.ids[1]!, { action: 'send' })); await started;
  const during = await f.messaging.draftReplySnapshot(f.context(turn.runId));
  expect(during.counts).toMatchObject({ pending: 1, sending: 1 });
  await f.settle(f.ids[1]!, 'cancel'); expect((await f.card(f.ids[1]!)).cardState).toBe('sending');
  release(); await sending;
  expect(await f.card(f.ids[1]!)).toMatchObject({ cardState: 'pending', sendError: 'Synthetic verification unavailable' });
  expect((await f.card(f.ids[1]!)).outcomeId).toBeUndefined();
  expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);
  const reply = await f.messaging.sendVisible({ ...f.context(turn.runId), draftStateRevision: during.revision }, { type: 'text', content: 'Only one remains?' });
  expect(reply.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed', draft_state: { pending: 2, sending: 0 } });
  expect(sends).toBe(0);
  await f.settle(f.ids[1]!, 'cancel'); expect((await f.card(f.ids[1]!)).cardState).toBe('dismissed');
 } finally { release(); await sending?.catch(() => {}); await f.cleanup(); }
});


test('a draft publication already in progress commits before cancellation can finish', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 let release: () => void = () => {}, published: () => void = () => {}, publishing: Promise<unknown> | undefined;
 const started = new Promise<void>(resolve => published = resolve), gate = new Promise<void>(resolve => release = resolve);
 let backend = 0, cancellation: Promise<unknown> | undefined;
 try {
  await f.create(0); await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId);
  publishing = f.prisma.$transaction(async tx => {
   const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; backend = rows[0]!.pid;
   expect((await publishDraftNotification(tx, f.context(turn.runId)))?.created).toBe(true);
   published(); await gate;
  }, { timeout: 15_000 });
  await started;
  cancellation = f.prisma.run.update({ where: { id: turn.runId }, data: { status: 'cancelled' } }).then(() => undefined);
  let blocked = false; const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
   const rows = await f.prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${backend} = ANY(pg_blocking_pids(pid))) AS blocked`;
   if (rows[0]?.blocked) { blocked = true; break; }
   await Bun.sleep(10);
  }
  expect(blocked).toBe(true);
  // Other connections cannot observe a partial status/receipt before the commit.
  expect(await f.visible()).toHaveLength(0);
  expect((await f.card(f.ids[0]!)).draftNotification.messageId).toBeUndefined();
  release(); await publishing; await cancellation;
  expect(await f.visible()).toHaveLength(1);
  expect((await f.messaging.flushDraftNotification(f.context(turn.runId)))?.acknowledgement).toMatchObject({ sent: false, silent: true });
  expect(await f.visible()).toHaveLength(1);
 } finally { release(); await publishing?.catch(() => {}); await cancellation?.catch(() => {}); await f.cleanup(); }
}, 30_000);


test('queued cancellation waits for a concurrent draft-outcome claim and then stops the running turn', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 let release: () => void = () => {}, entered: () => void = () => {}, claiming: Promise<unknown> | undefined, cancellation: Promise<unknown> | undefined;
 const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
 try {
  await f.create(0); const settled = await f.settle(f.ids[0]!, 'cancel'); const runId = settled.runId!;
  const inbox = await f.prisma.inboxEvent.findFirstOrThrow({ where: { runId } });
  const key = `bot-run-claim:${f.botId}`; let transportCalls = 0;
  const service = new RunService(f.prisma, async () => {
   transportCalls++; expect((await f.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('running');
   return Response.json({ cancelled: true });
  });
  // Hold exactly the row order a worker claim uses, after it has selected queued work.
  claiming = f.prisma.$transaction(async tx => {
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
   await tx.inboxEvent.update({ where: { id: inbox.id }, data: { status: 'processing' } }); entered(); await gate;
   await tx.run.update({ where: { id: runId }, data: { status: 'running' } });
  }, { timeout: 15_000 });
  await started; cancellation = Effect.runPromise(service.cancel(runId));
  await waitForDraftLockWaiter(f.prisma, key);
  expect((await f.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('queued');
  release(); await claiming; await cancellation;
  expect(transportCalls).toBe(1);
  expect((await f.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('cancelled');
  expect((await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: inbox.id } })).status).toBe('processing');
 } finally { release(); await claiming?.catch(() => {}); await cancellation?.catch(() => {}); await f.cleanup(); }
}, 30_000);


test('discard state and its durable outcome wake roll back together when queueing fails', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  const enqueue = f.messaging.enqueueDraftOutcome.bind(f.messaging);
  try {
   const id = await f.create(0);
   const updateEvents = () => f.prisma.event.count({ where: { topic: 'channel.message.updated', entityId: id } });
   const beforeEvents = await updateEvents();
   f.messaging.enqueueDraftOutcome = async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw new Error('injected outcome queue outage'); };
   await expect(f.settle(id, 'cancel')).rejects.toThrow('injected outcome queue outage');
   expect((await f.card(id)).cardState ?? 'pending').toBe('pending');
   expect(await updateEvents()).toBe(beforeEvents);
   expect(await f.prisma.run.count({ where: { botId: f.botId } })).toBe(1);
   expect(await f.prisma.message.count({ where: { botId: f.botId } })).toBe(1);
   expect((await f.card(id)).outcomeId).toBeUndefined();
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
   f.messaging.enqueueDraftOutcome = enqueue;
   await f.settle(id, 'cancel'); await f.settle(id, 'cancel');
   expect(await f.card(id)).toMatchObject({ cardState: 'dismissed', outcomeId: expect.any(String) });
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);
   // The same rollback boundary holds when another outcome wake is already queued.
   const second = await f.create(1);
   f.messaging.enqueueDraftOutcome = async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw new Error('injected coalescing outage'); };
   await expect(f.settle(second, 'cancel')).rejects.toThrow('injected coalescing outage');
   expect((await f.card(second)).cardState ?? 'pending').toBe('pending');
   expect((await f.card(second)).outcomeId).toBeUndefined();
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);
   expect(f.mailSends()).toBe(0);
  } finally { f.messaging.enqueueDraftOutcome = enqueue; await f.cleanup(); }
 }
});

test('a duplicate draft creation receipt names the stored card recipient rather than different retry arguments', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  const input = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Synthetic retry', body: 'Review only.', waitForReview: true };
  const context = f.context((await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id, 'same-creation-call');
  const first = await f.service.create(context, input) as any;
  const retry = await f.service.create(context, { ...input, to: ['bob@example.com'] }) as any;
  expect(retry).toMatchObject({ sent: true, duplicate: true, message_id: first.message_id, target: 'ann@example.com' });
  expect((await f.card(first.message_id)).draft.to).toEqual(['ann@example.com']);
  expect(await f.prisma.channelMessage.count({ where: { senderBotId: f.botId, metadata: { path: ['type'], equals: 'external-draft' } } })).toBe(1);
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});


test('a lost draft creation response is recoverable during a connector outage and preserves later review edits', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment'); let attempts = 0;
 try {
  const input = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Synthetic lost response', body: 'Review only.', waitForReview: true };
  const context = f.context((await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id, 'lost-creation-response');
  const first = await f.service.create(context, input) as any;
  await Effect.runPromise(f.service.mutate(first.message_id, { action: 'save', edits: { to: ['reviewed@example.com'] } }));
  const offline = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => { attempts++; throw new Error('Synthetic connector unavailable'); } } as never);
  const retry = await offline.create(context, input) as any;
  expect(retry).toMatchObject({ sent: true, duplicate: true, message_id: first.message_id, target: 'reviewed@example.com' });
  expect(attempts).toBe(0);
  expect((await f.card(first.message_id)).draft.to).toEqual(['reviewed@example.com']);
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});


test('concurrent creation retries agree with the single stored card and do not recreate discarded cards', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  const context = f.context((await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id, 'concurrent-creation');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.create(context, {
   platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: [`recipient${i}@example.com`], subject: 'Concurrent retry', body: 'Review only.', waitForReview: true,
  }) as Promise<any>));
  const ids = new Set(results.map(r => r.message_id)); expect(ids.size).toBe(1);
  const id = results[0]!.message_id, stored = await f.card(id);
  for (const result of results) expect(result.target).toBe(stored.draft.to.join(', '));
  await f.settle(id, 'cancel');
  const offline = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => { throw new Error('Connector should not be called'); } } as never);
  const retried = await offline.create(context, stored.draft) as any;
  expect(retried).toMatchObject({ duplicate: true, message_id: id, target: stored.draft.to.join(', '), delivery: 'dismissed' });
  const { renderControlResult } = await import('@openteam/contracts/tool-results');
  const readable = renderControlResult('DraftExternalMessage', retried, { ...stored.draft, to: ['wrong-retry@example.com'] });
  expect(readable).toContain('was discarded without sending'); expect(readable).not.toContain('wrong-retry@example.com');
  expect(readable).not.toContain('editable card');
  expect((await f.card(id)).cardState).toBe('dismissed');
  expect(await f.prisma.channelMessage.count({ where: { senderBotId: f.botId, metadata: { path: ['type'], equals: 'external-draft' } } })).toBe(1);
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});

test('room draft creation retries recover their private card while the connector is offline', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-room-retry'); let roomId: string | undefined, calls = 0;
 try {
  const room = await f.prisma.channel.create({ data: { kind: 'group', name: 'Synthetic draft room', members: { create: { botId: f.botId, ordinal: 0 } } } }); roomId = room.id;
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => { calls++; return { identity: 'me@example.com' }; } } as never);
  const context = { ...f.context('room-create'), channelId: room.id };
  const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Private room retry', body: 'Review only.', waitForReview: true };
  const first = await service.create(context, draft) as any; expect(first.in_dm).toBe(true);
  const before = calls;
  const offline = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => { calls++; throw new Error('Connector unavailable'); } } as never);
  expect(await offline.create(context, draft)).toMatchObject({ duplicate: true, message_id: first.message_id, target: 'ann@example.com', in_dm: true });
  expect(calls).toBe(before);
  expect((await f.prisma.channelMessage.findUniqueOrThrow({ where: { id: first.message_id } })).channelId).toBe(f.context('').channelId);
 } finally { if (roomId) await f.prisma.channel.deleteMany({ where: { id: roomId } }); await f.cleanup(); }
});

test('tampered attachment bytes prevent a send, preserve review, and remain discardable', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-tampered'); let sends = 0;
 const { writeFile } = await import('node:fs/promises');
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: `mock-${++sends}` } } as never);
 try {
  const path = join((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).defaultDirectory, 'review.txt'); await writeFile(path, 'Reviewed immutable bytes.');
  const card = await service.create(f.context('tamper-create'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Tamper test', body: 'Review only.', attachments: [path], waitForReview: true }) as any;
  const asset = (await f.card(card.message_id)).draft.verification.attachments[0];
  await writeFile(f.messaging.assets.contentPath(asset.assetId), 'X'.repeat(asset.byteSize));
  const blocked = await Effect.runPromise(service.mutate(card.message_id, { action: 'send' }));
  expect(blocked.message.metadata).toMatchObject({ cardState: 'pending', sendError: expect.stringContaining('Attachment content') });
  expect(sends).toBe(0); expect((await f.card(card.message_id)).outcomeId).toBeUndefined();
  await Effect.runPromise(service.mutate(card.message_id, { action: 'cancel' }));
  expect((await f.card(card.message_id)).cardState).toBe('dismissed');
  expect(sends).toBe(0);
 } finally { await f.cleanup(); }
});


test('progress updates do not requeue or rewrite a push already delivering or delivered', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment'), userId = crypto.randomUUID(); let deviceId: string | undefined;
 try {
  for (let i = 0; i < 3; i++) await f.create(i);
  await f.prisma.user.create({ data: { id: userId, name: 'Synthetic notification QA', email: `${userId}@openteam.invalid` } });
  const session = await f.prisma.session.create({ data: { id: crypto.randomUUID(), userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const device = await f.prisma.pushDevice.create({ data: { installationId: crypto.randomUUID(), platform: 'ios', pushToken: crypto.randomUUID(), authSessionId: session.id, authRequired: process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() !== 'disabled' } }); deviceId = device.id;
  const where = { target: device.id, payload: { path: ['channelId'], equals: f.context('').channelId } };
  const publish = async (id: string) => { await f.settle(id, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId); await f.messaging.flushDraftNotification(f.context(turn.runId)); await f.release(turn); };
  await publish(f.ids[0]!);
  const outbox = await f.prisma.outboxDelivery.findFirstOrThrow({ where }); const body = (outbox.payload as any).body;
  const progressId = (await f.visible())[0]!.id;
  for (const [index, status] of (['delivering', 'delivered'] as const).entries()) {
   await f.prisma.outboxDelivery.update({ where: { id: outbox.id }, data: { status } });
   await publish(f.ids[index + 1]!);
   const stored = await f.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: outbox.id } });
   expect(stored.status).toBe(status); expect((stored.payload as any).body).toBe(body);
   expect(await f.prisma.outboxDelivery.count({ where })).toBe(1);
   expect(await f.visible()).toHaveLength(1); expect((await f.visible())[0]!.id).toBe(progressId);
  }
  const final = (await f.visible())[0]!; expect(final.content).toContain('none awaiting review');
  expect(((await f.prisma.channelNotification.findUniqueOrThrow({ where: { key: `message:${progressId}` } })).payload as any).body).toBe(final.content);
  expect((final.metadata as any).draftOutcomeNotification.outcomeIds).toHaveLength(3);
  expect(f.mailSends()).toBe(0);
 } finally {
  if (deviceId) { await f.prisma.outboxDelivery.deleteMany({ where: { target: deviceId } }); await f.prisma.pushDevice.deleteMany({ where: { id: deviceId } }); }
  await f.prisma.user.deleteMany({ where: { id: userId } }); await f.cleanup();
 }
}, 15_000);


test('legacy computers without a revision cannot publish after cancellation wins an in-flight call', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) for (const type of ['text', 'widget'] as const) {
  const f = await notificationExperiment(variant);
  let release: () => void = () => {}, locked: () => void = () => {}, barrier: Promise<unknown> | undefined;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => locked = r);
  try {
   await f.create(0); await f.create(1); await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId);
   const context = f.context(turn.runId), key = `agent-lifecycle:${f.botId}`;
   barrier = f.prisma.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`; locked(); await gate; }, { timeout: 15_000 });
   await started;
   // Tool entry was validated while running; an old computer omits the optional revision.
   const reply = f.messaging.sendVisible(context, type === 'text' ? { type, content: 'Legacy late confirmation' } : { type, widget: { prompt: 'Revise?', options: [{ label: 'Revise', value: 'revise' }] } });
   await waitForDraftLockWaiter(f.prisma, key);
   await f.prisma.run.update({ where: { id: turn.runId }, data: { status: 'cancelled' } }); release(); await barrier;
   expect((await reply).acknowledgement).not.toMatchObject({ sent: true });
   expect(await f.visible()).toHaveLength(0);
   expect(await f.prisma.channelMessage.count({ where: { channelId: context.channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
  } finally { release(); await barrier?.catch(() => {}); await f.cleanup(); }
 }
}, 30_000);

test('a fresh automatic-send failure is not described to the model as an editable draft', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-auto-failed'); let verifies = 0, sends = 0;
 try {
  await f.prisma.bot.update({ where: { id: f.botId }, data: { draftingDisabled: true } });
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') return { identity: ++verifies === 1 ? 'me@example.com' : 'other@example.com', sendingAddresses: ['me@example.com'] };
   sends++; return { id: 'mock-never' };
  } } as never);
  const args = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Synthetic failed auto send', body: 'Do not actually send.' };
  const result = await service.create(f.context('auto-failed'), args) as any;
  expect(result.delivery).toBe('failed'); expect((await f.card(result.message_id)).cardState).toBe('failed'); expect(sends).toBe(0);
  const { renderControlResult } = await import('@openteam/contracts/tool-results'); const text = renderControlResult('DraftExternalMessage', result, args);
  expect(text).not.toContain('editable card'); expect(text).toContain('not delivered'); expect(text).toContain('account changed');
 } finally { await f.cleanup(); }
});

test('a fresh unconfirmed send is not formatted as a completed send or permission to retry', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-auto-unknown'); let attempts = 0;
 try {
  await f.prisma.bot.update({ where: { id: f.botId }, data: { draftingDisabled: true } });
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
   attempts++; throw new Error('Synthetic connection lost after entering send');
  } } as never);
  const args = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Synthetic unconfirmed auto send', body: 'Synthetic bytes only.' };
  const result = await service.create(f.context('auto-unknown'), args) as any;
  expect(result.delivery).toBe('unknown'); expect(attempts).toBe(1);
  const { renderControlResult } = await import('@openteam/contracts/tool-results'); const text = renderControlResult('DraftExternalMessage', result, args);
  expect(text).not.toContain('was sent without review'); expect(text).toContain('unconfirmed'); expect(text).toContain('Do not resend');
 } finally { await f.cleanup(); }
});


test('active legacy computers still deliver useful questions without supplying a revision', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   await f.create(0); await f.create(1); await f.settle(f.ids[0]!, 'cancel'); await f.ready(); const turn = await f.worker().claim(f.botId);
   const result = await f.messaging.sendVisible(f.context(turn.runId), { type: 'widget', widget: { prompt: 'Revise the remaining draft?', options: [{ label: 'Revise', value: 'revise' }] } });
   expect(result.acknowledgement).toMatchObject({ sent: true });
   expect(await f.prisma.channelMessage.count({ where: { channelId: f.context('').channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(1);
   expect(f.mailSends()).toBe(0);
  } finally { await f.cleanup(); }
 }
});

test('archive and deletion while verification is in flight cannot create a new review card', async () => {
 if (!databaseUrl) return;
 for (const action of ['archive', 'delete'] as const) {
  const f = await fixture(`draft-lifecycle-${action}`); let enter: () => void = () => {}, release: () => void = () => {}, creating: Promise<unknown> | undefined, sends = 0;
  const entered = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  try {
   const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
    if (input.arguments.action === 'verify') { enter(); await gate; return { identity: 'me@example.com' }; }
    sends++; return { id: 'mock-never' };
   } } as never);
   creating = service.create(f.context('in-flight-create'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Lifecycle boundary', body: 'Review only.', waitForReview: true });
   // Attach the rejection handler immediately; the gate controls the completion.
   const result = creating.then(value => ({ value, error: null }), error => ({ value: null, error }));
   await entered;
   if (action === 'archive') await f.prisma.channel.update({ where: { id: f.context('').channelId }, data: { archivedAt: new Date() } });
   else await f.prisma.bot.delete({ where: { id: f.botId } });
   release(); expect((await result).error).not.toBeNull();
   expect(await f.prisma.channelMessage.count({ where: { channelId: f.context('').channelId } })).toBe(0);
   expect(sends).toBe(0);
  } finally { release(); await creating?.catch(() => {}); await f.cleanup(); }
 }
});

test('another bot outcomes cannot invalidate a current reply snapshot', async () => {
 if (!databaseUrl) return;
 const first = await notificationExperiment('treatment'), second = await notificationExperiment('treatment');
 try {
  await first.create(0); await first.create(1); await first.settle(first.ids[0]!, 'cancel'); await first.ready(); const turn = await first.worker().claim(first.botId);
  const context = first.context(turn.runId), snapshot = await first.messaging.draftReplySnapshot(context);
  for (let i = 0; i < 4; i++) await second.settle(await second.create(i), 'cancel');
  const result = await first.messaging.sendVisible({ ...context, draftStateRevision: snapshot.revision }, { type: 'widget', widget: { prompt: 'Revise your remaining draft?', options: [{ label: 'Revise', value: 'revise' }] } });
  expect(result.acknowledgement).toMatchObject({ sent: true });
  expect((await first.messaging.draftReplySnapshot(context)).revision).toBe(snapshot.revision);
  expect(await second.prisma.channelMessage.count({ where: { channelId: second.context('').channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
 } finally { await first.cleanup(); await second.cleanup(); }
});

test('restart recovery uses immutable attachment bytes after the original file disappears', async () => {
 if (!databaseUrl) return;
 const f = await fixture('draft-attachment-restart'); const { writeFile } = await import('node:fs/promises'); let sends = 0, payload: any;
 try {
  const path = join((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).defaultDirectory, 'restart.txt'); await writeFile(path, 'Immutable reviewed restart bytes.');
  const args = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Restart attachment', body: 'Review only.', attachments: [path], waitForReview: true };
  const context = f.context('restart-create');
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => { if (input.arguments.action === 'verify') return { identity: 'me@example.com' }; sends++; payload = input.arguments.draft; return { id: 'synthetic-only' }; } } as never);
  const first = await service.create(context, args) as any; await rm(path);
  const restartedMessaging = new AgentMessaging(f.prisma, f.messaging.boss, f.messaging.agentData);
  const restarted = new ExternalDraftService(f.prisma, restartedMessaging, { invoke: async () => { throw new Error('Offline verification must not run for a stored receipt'); } } as never);
  expect(await restarted.create(context, args)).toMatchObject({ duplicate: true, message_id: first.message_id, delivery: 'pending' });
  expect(sends).toBe(0);
  await Effect.runPromise(service.mutate(first.message_id, { action: 'send' }));
  expect(sends).toBe(1); expect(Buffer.from(payload.attachments[0].content, 'base64').toString()).toBe('Immutable reviewed restart bytes.');
  expect((await f.card(first.message_id)).cardState).toBe('sent');
 } finally { await f.cleanup(); }
});


test('seeded draft state machine preserves reviewed content, terminal outcomes and transport-at-most-once', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) for (const seed of [1, 7, 42, 99]) {
  const f = await notificationExperiment(variant);
  let phase: 'good' | 'before' | 'after' | 'account' = 'good', random = seed;
  const packets: any[] = [], model: Array<{ id: string; state: string; body: string; to: string[]; outcome: string | undefined }> = [];
  const next = (n: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') {
    if (phase === 'before') throw new Error('Synthetic verification outage');
    return { identity: phase === 'account' ? 'other@example.com' : 'me@example.com', sendingAddresses: ['me@example.com'] };
   }
   packets.push(input); if (phase === 'after') throw new Error('Synthetic lost transport response');
   return { id: `mock-${packets.length}` };
  } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  let expectedAttempts = 0, expectedWakes = 0;
  try {
   const seedRun = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   for (let i = 0; i < 6; i++) {
    const body = `Reviewed body ${i}`, to = [`recipient${i}@example.com`];
    const created = await service.create(f.context(seedRun, `state-machine-${i}`), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to, subject: `State machine ${i}`, body, waitForReview: true }) as any;
    model.push({ id: created.message_id, state: 'pending', body, to, outcome: undefined });
   }
   const apply = async (index: number, action: 'send' | 'cancel' | 'save' | 'refresh' | 'bad-save', step: number) => {
    const expected = model[index]!, editable = expected.state === 'pending';
    const edits = action === 'save' || action === 'bad-save' ? { body: `Edited body ${step}`, to: action === 'bad-save' ? ['invalid@'] : [`edited${step}@example.com`] } : undefined;
    let error: unknown; try { await Effect.runPromise(service.mutate(expected.id, { action: action === 'bad-save' ? 'save' : action, ...(edits ? { edits } : {}) })); } catch (e) { error = e; }
    if (editable && action === 'bad-save') expect(error).toBeDefined(); else expect(error).toBeUndefined();
    if (editable) {
     if (action === 'save') { expected.body = edits!.body; expected.to = edits!.to; }
     if (action === 'cancel') { expected.state = 'dismissed'; expectedWakes++; }
     if (action === 'send') {
      if (phase === 'good' || phase === 'after') { expectedAttempts++; expect(packets.at(-1).arguments.draft).toMatchObject({ body: expected.body, to: expected.to }); }
      expected.state = phase === 'good' ? 'sent' : phase === 'after' ? 'unknown' : phase === 'account' ? 'failed' : 'pending';
      if (expected.state === 'sent' || expected.state === 'failed') expectedWakes++;
     }
    }
    const actual = await f.card(expected.id);
    expect(actual.cardState ?? 'pending').toBe(expected.state);
    expect(actual.draft.body).toBe(expected.body); expect(actual.draft.to).toEqual(expected.to);
    expect(packets.length).toBe(expectedAttempts);
    if (expected.state === 'pending') expect(actual.outcomeId).toBeUndefined();
    else { if (expected.outcome) expect(actual.outcomeId).toBe(expected.outcome); else expected.outcome = actual.outcomeId; expect(actual.outcomeId).toEqual(expect.any(String)); }
   };
   // Guarantee coverage of every terminal state before randomized edits/retries.
   phase = 'good'; await apply(0, 'send', -1); phase = 'after'; await apply(1, 'send', -2);
   phase = 'account'; await apply(2, 'send', -3); phase = 'good'; await apply(3, 'cancel', -4);
   const actions = ['send', 'cancel', 'save', 'refresh', 'bad-save'] as const, phases = ['good', 'before', 'after', 'account'] as const;
   for (let step = 0; step < 30; step++) { phase = phases[next(phases.length)]!; await apply(next(model.length), actions[next(actions.length)]!, step); }
   const actualWakes = await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } });
   expect(actualWakes).toBe(variant === 'treatment' ? Math.min(expectedWakes, 1) : expectedWakes);
   for (const card of model.filter(m => m.state !== 'pending')) expect((await f.card(card.id)).outcomeId).toBe(card.outcome);
  } finally { await f.cleanup(); }
 }
}, 30_000);

test('a verification failure arriving after sending times out cannot reopen the terminal card', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  let release = () => {}, entered = () => {}, verifies = 0, sends = 0;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') {
    if (++verifies > 1) { entered(); await gate; throw new Error('Late verification outage'); }
    return { identity: 'me@example.com' };
   }
   sends++; return { id: 'synthetic-only' };
  } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  let sending: Promise<unknown> | undefined;
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'timeout-failure'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Late verification failure', body: 'Synthetic timeout' }) as any;
   sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await waiting;
   const stored = await f.card(card.message_id);
   await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...stored, sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
   await Effect.runPromise(service.mutate(card.message_id, { action: 'refresh' }));
   const terminal = await f.card(card.message_id); expect(terminal.cardState).toBe('unknown');
   release(); await sending;
   expect(await f.card(card.message_id)).toMatchObject({ cardState: 'unknown', outcomeId: terminal.outcomeId });
   expect((await f.card(card.message_id)).sendError).toBeUndefined();
   expect(sends).toBe(0);
   await Effect.runPromise(service.mutate(card.message_id, { action: 'send' }));
   expect(verifies).toBe(2); expect(sends).toBe(0);
  } finally { release(); await sending?.catch(() => {}); await f.cleanup(); }
 }
});

test('verification finishing after a sending timeout cannot start a new external send', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 let release = () => {}, entered = () => {}, verifies = 0, sends = 0;
 const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  if (input.arguments.action === 'verify') { if (++verifies > 1) { entered(); await gate; } return { identity: 'me@example.com' }; }
  sends++; return { id: 'synthetic-only' };
 } } as never, { treatmentPercent: '100' });
 let sending: Promise<unknown> | undefined;
 try {
  const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
  const card = await service.create(f.context(runId, 'timeout-success'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Late verification', body: 'Synthetic timeout' }) as any;
  sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await waiting;
  const stored = await f.card(card.message_id);
  await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...stored, sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
  await Effect.runPromise(service.mutate(card.message_id, { action: 'refresh' }));
  const terminal = await f.card(card.message_id); expect(terminal.cardState).toBe('unknown');
  release(); await sending;
  expect(sends).toBe(0);
  expect(await f.card(card.message_id)).toMatchObject({ cardState: 'unknown', outcomeId: terminal.outcomeId });
 } finally { release(); await sending?.catch(() => {}); await f.cleanup(); }
});

test('a delayed refresh cannot settle a reopened card or a later send attempt', async () => {
 if (!databaseUrl) return;
 for (const retry of [false, true]) {
  const f = await notificationExperiment('treatment');
  let releaseVerify = () => {}, enteredVerify = () => {}, releaseRead = () => {}, enteredRead = () => {}, verifies = 0, sends = 0;
  const verifyGate = new Promise<void>(r => releaseVerify = r), verifying = new Promise<void>(r => enteredVerify = r);
  const readGate = new Promise<void>(r => releaseRead = r), reading = new Promise<void>(r => enteredRead = r);
  let releaseRetry = () => {}, enteredRetry = () => {};
  const retryGate = new Promise<void>(r => releaseRetry = r), retrying = new Promise<void>(r => enteredRetry = r);
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') {
    verifies++;
    if (verifies === 2) { enteredVerify(); await verifyGate; throw new Error('First attempt verification failed'); }
    if (verifies === 3) { enteredRetry(); await retryGate; }
    return { identity: 'me@example.com' };
   }
   sends++; return { id: 'synthetic-retry' };
  } } as never, { treatmentPercent: '100' });
  const lookup = f.prisma.pluginInvocation.findUnique.bind(f.prisma.pluginInvocation);
  let sending: Promise<unknown> | undefined, refresh: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'stale-refresh'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Stale refresh', body: 'Synthetic retry' }) as any;
   sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await verifying;
   const firstStartedAt = new Date(Date.now() - 181_000).toISOString();
   await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...await f.card(card.message_id), sendStartedAt: firstStartedAt } } });
   f.prisma.pluginInvocation.findUnique = (async (...args: Parameters<typeof lookup>) => { enteredRead(); await readGate; return lookup(...args); }) as unknown as typeof lookup;
   refresh = Effect.runPromise(service.mutate(card.message_id, { action: 'refresh' })); await reading;
   releaseVerify(); await sending; expect((await f.card(card.message_id)).cardState).toBe('pending');
   if (retry) {
    second = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await retrying;
    // A repeated wall-clock value must not make two attempts indistinguishable.
    const current = await f.card(card.message_id);
    await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...current, sendStartedAt: firstStartedAt } } });
   }
   releaseRead(); await refresh;
   expect((await f.card(card.message_id)).cardState).toBe(retry ? 'sending' : 'pending');
   expect((await f.card(card.message_id)).outcomeId).toBeUndefined();
   releaseRetry(); await second;
   expect(sends).toBe(retry ? 1 : 0);
   expect((await f.card(card.message_id)).cardState).toBe(retry ? 'sent' : 'pending');
  } finally {
   releaseRead(); releaseVerify(); releaseRetry(); await Promise.allSettled([sending, refresh, second].filter(Boolean) as Promise<unknown>[]);
   f.prisma.pluginInvocation.findUnique = lookup; await f.cleanup();
  }
 }
});

test('timeout fencing covers email and Slack, review and automatic sends, and both variants', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) for (const platform of ['email', 'slack'] as const)
 for (const automatic of [false, true]) for (const response of ['success', 'outage', 'account-change'] as const) {
  const f = await notificationExperiment(variant);
  let release = () => {}, entered = () => {}, verifies = 0, sends = 0;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify' || input.toolName === 'slack_read_channel') {
    if (++verifies > 1) { entered(); await gate; if (response === 'outage') throw new Error('Late synthetic outage'); }
    return platform === 'email' ? { identity: verifies > 1 && response === 'account-change' ? 'other@example.com' : 'me@example.com', sendingAddresses: ['me@example.com'] } : { messages: 'Channel: general (C12345678)' };
   }
   if (input.toolName === 'slack_read_user_profile') return { result: `Organization Name: Fixture\nEmail: ${verifies > 1 && response === 'account-change' ? 'other' : 'me'}@example.com` };
   sends++; return { id: 'synthetic-only' };
  } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  let operation: Promise<any> | undefined;
  try {
   await f.prisma.bot.update({ where: { id: f.botId }, data: { draftingDisabled: automatic } });
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const draft = { platform, providerIdentifier: f.connection.id, body: 'Synthetic timeout matrix', ...(platform === 'email' ? { from: 'me@example.com', to: ['ann@example.com'], subject: 'Timeout matrix' } : { target: 'general', channelId: 'C12345678' }) };
   const creating = service.create(f.context(runId, 'timeout-matrix'), draft);
   let id: string;
   if (automatic) {
    operation = creating; await waiting;
    id = (await f.prisma.channelMessage.findFirstOrThrow({ where: { senderBotId: f.botId, metadata: { path: ['type'], equals: 'external-draft' } } })).id;
   } else {
    id = String((await creating as any).message_id); operation = Effect.runPromise(service.mutate(id, { action: 'send' })); await waiting;
   }
   await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...await f.card(id), sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
   await Effect.runPromise(service.mutate(id, { action: 'refresh' }));
   const terminal = await f.card(id); expect(terminal.cardState).toBe('unknown');
   release(); const result = await operation;
   if (automatic) expect(result.delivery).toBe('unknown');
   else expect(result.message.metadata.cardState).toBe('unknown');
   for (const action of ['send', 'cancel', 'save', 'refresh']) await Effect.runPromise(service.mutate(id, { action, ...(action === 'save' ? { edits: { body: 'Must not replace terminal content' } } : {}) }));
   expect(await f.card(id)).toMatchObject({ cardState: 'unknown', outcomeId: terminal.outcomeId, draft: { body: draft.body } });
   expect((await f.card(id)).sendError).toBeUndefined(); expect(sends).toBe(0); expect(verifies).toBe(2);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
  } finally { release(); await operation?.catch(() => {}); await f.cleanup(); }
 }
}, 30_000);

test('a confirmed plugin send survives outcome queue rollback and recovers without another transport call', async () => {
 if (!databaseUrl) return;
 const { PluginInvocations } = await import('../src/services/plugin/invocations');
 for (const variant of ['control', 'treatment'] as const) for (const legacy of [false, true]) {
  const f = await notificationExperiment(variant);
  const enqueue = f.messaging.enqueueDraftOutcome.bind(f.messaging);
  let sends = 0;
  const plugins = new PluginInvocations(f.prisma, async (callId) => {
   const call = await f.prisma.pluginInvocation.findUniqueOrThrow({ where: { callId } });
   const result = (call.arguments as any).action === 'verify' ? { identity: 'me@example.com' } : { id: `synthetic-${++sends}` };
   await f.prisma.pluginInvocation.update({ where: { callId }, data: { status: 'completed', result, completedAt: new Date() } });
   return result;
  });
  const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'confirmed-queue-failure'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Confirmed synthetic send', body: 'No real transport' }) as any;
   f.messaging.enqueueDraftOutcome = async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw new Error('Synthetic post-send queue rollback'); };
   await expect(Effect.runPromise(service.mutate(card.message_id, { action: 'send' }))).rejects.toThrow('Synthetic post-send queue rollback');
   expect(await f.card(card.message_id)).toMatchObject({ cardState: 'sending' });
   expect((await f.card(card.message_id)).outcomeId).toBeUndefined();
   expect(sends).toBe(1);
   expect(await f.prisma.pluginInvocation.findUniqueOrThrow({ where: { callId: `draft-send:${card.message_id}:send` } })).toMatchObject({ status: 'completed', result: { id: 'synthetic-1' } });
   if (legacy) {
    const { sendAttemptId: _attempt, ...stored } = await f.card(card.message_id);
    await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: stored } });
   }
   f.messaging.enqueueDraftOutcome = enqueue;
   const restarted = new ExternalDraftService(f.prisma, f.messaging, plugins as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
   await Promise.all(['refresh', 'send', 'refresh'].map(action => Effect.runPromise(restarted.mutate(card.message_id, { action }))));
   expect(await f.card(card.message_id)).toMatchObject({ cardState: 'sent', outcomeId: expect.any(String) });
   expect(sends).toBe(1);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);
  } finally { f.messaging.enqueueDraftOutcome = enqueue; await f.cleanup(); }
 }
});

test('a transport already entered before timeout is never repeated after its late result', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) for (const fails of [false, true]) {
  const f = await notificationExperiment(variant);
  let release = () => {}, entered = () => {}, sends = 0;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
   sends++; entered(); await gate; if (fails) throw new Error('Synthetic late response loss'); return { id: 'synthetic-late-success' };
  } } as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  let sending: Promise<unknown> | undefined;
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'late-transport'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Late transport response', body: 'Synthetic bytes' }) as any;
   sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })); await waiting;
   await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...await f.card(card.message_id), sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
   await Effect.runPromise(service.mutate(card.message_id, { action: 'refresh' }));
   const outcome = (await f.card(card.message_id)).outcomeId;
   release(); await sending;
   await Promise.all(['send', 'send', 'cancel', 'refresh'].map(action => Effect.runPromise(service.mutate(card.message_id, { action }))));
   expect(await f.card(card.message_id)).toMatchObject({ cardState: 'unknown', outcomeId: outcome });
   expect(sends).toBe(1);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
  } finally { release(); await sending?.catch(() => {}); await f.cleanup(); }
 }
});

test('archiving the channel or deleting the card during verification prevents dispatch', async () => {
 if (!databaseUrl) return;
 for (const removal of ['archive', 'delete'] as const) {
  const f = await notificationExperiment('treatment');
  let release = () => {}, entered = () => {}, verifies = 0, sends = 0;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') { if (++verifies > 1) { entered(); await gate; } return { identity: 'me@example.com' }; }
   sends++; return { id: 'synthetic-only' };
  } } as never);
  let sending: Promise<unknown> | undefined;
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'removed-before-dispatch'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Removed card', body: 'Synthetic only' }) as any;
   sending = Effect.runPromise(service.mutate(card.message_id, { action: 'send' })).then(value => ({ value }), error => ({ error })); await waiting;
   if (removal === 'archive') await f.prisma.channel.update({ where: { id: f.context(runId).channelId }, data: { archivedAt: new Date() } });
   else await f.prisma.channelMessage.delete({ where: { id: card.message_id } });
   release(); await sending;
   expect(sends).toBe(0);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
   if (removal === 'delete') expect(await f.prisma.channelMessage.findUnique({ where: { id: card.message_id } })).toBeNull();
  } finally { release(); await sending?.catch(() => {}); await f.cleanup(); }
 }
});

test('attachment preparation finishing after timeout cannot send or reopen the settled card', async () => {
 if (!databaseUrl) return;
 for (const missing of [false, true]) {
  const f = await notificationExperiment('treatment');
  const path = join((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).defaultDirectory, 'delayed.txt');
  const normalize = f.messaging.assets.normalizeRefs.bind(f.messaging.assets);
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(r => release = r), preparing = new Promise<void>(r => entered = r);
  let sending: Promise<unknown> | undefined;
  try {
   await Bun.write(path, 'Immutable synthetic attachment.');
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const created = await f.service.create(f.context(runId, 'slow-attachment'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Delayed attachment', body: 'Synthetic only', attachments: [path] }) as any;
   const id = created.message_id;
   f.messaging.assets.normalizeRefs = async (...args: Parameters<typeof normalize>) => { entered(); await gate; return normalize(...args); };
   sending = Effect.runPromise(f.service.mutate(id, { action: 'send' })); await preparing;
   const original = await f.card(id);
   await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...original, sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
   await Effect.runPromise(f.service.mutate(id, { action: 'refresh' }));
   const outcome = (await f.card(id)).outcomeId;
   if (missing) await rm(f.messaging.assets.contentPath(original.draft.verification.attachments[0].assetId));
   release(); await sending;
   expect(await f.card(id)).toMatchObject({ cardState: 'unknown', outcomeId: outcome, draft: { body: 'Synthetic only' } });
   expect((await f.card(id)).sendError).toBeUndefined();
   expect(f.mailSends()).toBe(0);
  } finally { release(); await sending?.catch(() => {}); f.messaging.assets.normalizeRefs = normalize; await f.cleanup(); }
 }
});

test('restart recovery keeps unreadable completed connector responses unconfirmed', async () => {
 if (!databaseUrl) return;
 const replies = [
  { content: [{ type: 'text', text: 'The response was lost after the remote operation.' }] },
  { isError: true, content: [{ type: 'text', text: 'Synthetic connector wrapper error' }] },
  { structuredContent: { error: 'Synthetic result decoding failure' } },
  [],
  {},
 ];
 for (const variant of ['control', 'treatment'] as const) for (const result of replies) {
  const f = await notificationExperiment(variant);
  try {
   const id = await f.create(0), stored = await f.card(id), runId = stored.draft.runId;
   await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: new Date().toISOString(), sendAttemptId: crypto.randomUUID() } } });
   await f.prisma.pluginInvocation.create({ data: { callId: `draft-send:${id}:send`, connectionId: f.connection.id, botId: f.botId, runId, toolName: 'send_reviewed_email', arguments: { action: 'send', draft: stored.draft }, status: 'completed', result } });
   await Effect.runPromise(f.service.mutate(id, { action: 'refresh' }));
   const recovered = await f.card(id);
   expect(recovered.cardState).toBe('unknown');
   expect(recovered.outcomeText).toContain('may or may not have gone out');
   expect(recovered.outcomeText).not.toContain('reported a send failure');
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
   await Promise.all(['send', 'refresh', 'cancel'].map(action => Effect.runPromise(f.service.mutate(id, { action }))));
   expect(f.mailSends()).toBe(0); expect((await f.card(id)).outcomeId).toBe(recovered.outcomeId);
   // The same unreadable response must not be called sent in a fresh automatic result.
   await f.prisma.bot.update({ where: { id: f.botId }, data: { draftingDisabled: true } });
   const live = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : result } as never);
   const receipt = await live.create(f.context(runId, 'fresh-unreadable'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Unreadable live response', body: 'Synthetic only' }) as any;
   expect(receipt.delivery).toBe('unknown');
   expect(receipt.note).toContain('may or may not have gone out');
  } finally { await f.cleanup(); }
 }
});

test('a reviewed draft remains bound to its original connection after the account is renamed', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 const calls: any[] = [];
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
  calls.push(input); return input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: 'synthetic-original-account' };
 } } as never);
 try {
  const namespace = (await loadConnectionNamespaces(f.prisma)).get(f.connection.id)!;
  const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
  const draft = { platform: 'email', providerIdentifier: namespace, from: 'me@example.com', to: ['ann@example.com'], subject: 'Renamed account', body: 'Keep the reviewed route' };
  const card = await service.create(f.context(runId, 'rename-pending'), draft) as any;
  await f.prisma.pluginConnection.update({ where: { id: f.connection.id }, data: { alias: 'renamed-account' } });
  expect((await loadConnectionNamespaces(f.prisma)).get(f.connection.id)).not.toBe(namespace);
  await Effect.runPromise(service.mutate(card.message_id, { action: 'send' }));
  expect((await f.card(card.message_id)).cardState).toBe('sent');
  expect(calls.filter(call => call.arguments.action === 'send')).toHaveLength(1);
  expect(calls.at(-1).connectionId).toBe(f.connection.id);
 } finally { await f.cleanup(); }
});

test('connector result recovery cannot borrow another bot run account or tool receipt', async () => {
 if (!databaseUrl) return;
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant), other = await notificationExperiment(variant);
  try {
   const otherRun = (await other.prisma.run.findFirstOrThrow({ where: { botId: other.botId } })).id;
   for (const [i, mismatch] of ['bot', 'run', 'account', 'tool'].entries()) {
    const id = await f.create(i), stored = await f.card(id);
    await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: new Date().toISOString(), sendAttemptId: crypto.randomUUID() } } });
    await f.prisma.pluginInvocation.create({ data: { callId: `draft-send:${id}:send`, connectionId: mismatch === 'account' ? other.connection.id : f.connection.id, botId: mismatch === 'bot' ? other.botId : f.botId, runId: mismatch === 'run' ? otherRun : stored.draft.runId, toolName: mismatch === 'tool' ? 'unrelated_tool' : 'send_reviewed_email', arguments: {}, status: 'completed', result: { id: 'unrelated-success' } } });
    await Effect.runPromise(f.service.mutate(id, { action: 'refresh' }));
    expect((await f.card(id)).cardState).toBe('unknown');
    expect((await f.card(id)).outcomeText).not.toContain('user sent');
   }
   expect(f.mailSends()).toBe(0);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
  } finally { await other.cleanup(); await f.cleanup(); }
 }
});

test('namespace reuse cannot reroute current or legacy email and Slack cards', async () => {
 if (!databaseUrl) return;
 const { PluginInvocations } = await import('../src/services/plugin/invocations');
 for (const platform of ['email', 'slack'] as const) for (const provenance of ['current', 'legacy-verified', 'legacy-unverified', 'legacy-prefix-collision'] as const) {
  const f = await notificationExperiment('treatment');
  const packets: any[] = [];
  const tools = ['slack_read_channel', 'slack_read_user_profile', 'slack_send_message'].map(name => ({ name, description: 'Synthetic', inputSchema: { type: 'object' } }));
  const plugins = new PluginInvocations(f.prisma, async (callId) => {
   const call = await f.prisma.pluginInvocation.findUniqueOrThrow({ where: { callId } });
   let result: any;
   if ((call.arguments as any).action === 'verify') result = { identity: 'me@example.com' };
   else if (call.toolName === 'slack_read_channel') result = { messages: 'Channel: general (C12345678)' };
   else if (call.toolName === 'slack_read_user_profile') result = { result: 'Organization Name: Fixture\nEmail: me@example.com' };
   else { packets.push(call); result = { id: 'synthetic-only' }; }
   await f.prisma.pluginInvocation.update({ where: { callId }, data: { status: 'completed', result } }); return result;
  });
  const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never, { treatmentPercent: '100' });
  try {
   const name = `Unique fixture ${crypto.randomUUID()}`;
   await f.prisma.pluginConnection.update({ where: { id: f.connection.id }, data: { name, toolSnapshot: tools } });
   const namespace = (await loadConnectionNamespaces(f.prisma)).get(f.connection.id)!;
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const draft = { platform, providerIdentifier: namespace, body: 'Reviewed route remains immutable', ...(platform === 'email' ? { from: 'me@example.com', to: ['ann@example.com'], subject: 'Namespace reuse' } : { target: 'general', channelId: 'C12345678' }) };
   const card = await service.create(f.context(runId, 'reuse-route'), draft) as any;
   if (provenance !== 'current') {
    const stored = await f.card(card.message_id);
    await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...stored, draft: { ...stored.draft, providerIdentifier: namespace } } } });
   }
   if (provenance === 'legacy-unverified' || provenance === 'legacy-prefix-collision') await f.prisma.pluginInvocation.deleteMany({ where: { botId: f.botId, callId: { startsWith: 'draft-verify:reuse-route:' } } });
   await f.prisma.pluginConnection.update({ where: { id: f.connection.id }, data: { alias: 'renamed-account' } });
   const replacement = await f.prisma.pluginConnection.create({ data: { installationId: f.connection.installationId, connectorKey: 'email', name, transport: 'stdio', authType: 'none', status: 'ready', toolSnapshot: tools } });
   expect((await loadConnectionNamespaces(f.prisma)).get(replacement.id)).toBe(namespace);
   if (provenance === 'legacy-prefix-collision') await f.prisma.pluginInvocation.create({ data: { callId: 'draft-verify:reuse-route:lookalike:send_reviewed_email', connectionId: replacement.id, botId: f.botId, runId, toolName: 'send_reviewed_email', status: 'completed', result: { identity: 'me@example.com' } } });
   await Effect.runPromise(service.mutate(card.message_id, { action: 'send' }));
   if (provenance === 'current' || provenance === 'legacy-verified') {
    expect((await f.card(card.message_id)).cardState).toBe('sent');
    expect(packets).toHaveLength(1); expect(packets[0].connectionId).toBe(f.connection.id);
   } else {
    expect((await f.card(card.message_id)).cardState).toBe('pending');
    expect((await f.card(card.message_id)).sendError).toContain('original account');
    expect(packets).toHaveLength(0);
    await Effect.runPromise(service.mutate(card.message_id, { action: 'cancel' }));
    expect((await f.card(card.message_id)).cardState).toBe('dismissed');
   }
  } finally { await f.cleanup(); }
 }
}, 30_000);

test('revision highlighting survives a legacy namespace and an account rename', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async () => ({ identity: 'me@example.com' }) } as never);
 try {
  const namespace = (await loadConnectionNamespaces(f.prisma)).get(f.connection.id)!;
  const run = await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } });
  const draft = { platform: 'email', providerIdentifier: namespace, from: 'me@example.com', to: ['ann@example.com'], subject: 'Schedule', body: 'Hi Ann,\n\nThe meeting is on Monday at ten. Please bring the project notes.\n\nThanks!' };
  const baseline = await service.create(f.context(run.id, 'baseline'), draft) as any;
  const old = await f.card(baseline.message_id);
  await f.prisma.channelMessage.update({ where: { id: baseline.message_id }, data: { metadata: { ...old, draft: { ...old.draft, providerIdentifier: namespace } } } });
  await f.prisma.pluginInvocation.create({ data: { callId: 'draft-verify:baseline:send_reviewed_email', connectionId: f.connection.id, botId: f.botId, runId: run.id, toolName: 'send_reviewed_email', arguments: { action: 'verify' }, status: 'completed', result: { identity: 'me@example.com' } } });
  await f.prisma.pluginConnection.update({ where: { id: f.connection.id }, data: { alias: 'renamed' } });
  await f.prisma.channelMessage.create({ data: { channelId: f.context(run.id).channelId, sender: 'user', content: 'Change Monday to Tuesday', clientId: crypto.randomUUID() } });
  const next = await f.prisma.run.create({ data: { botId: f.botId, conversationId: run.conversationId, channelId: run.channelId, userMessageId: crypto.randomUUID(), status: 'running' } });
  const updatedBody = draft.body.replace('Monday', 'Tuesday');
  const updated = await service.create(f.context(next.id, 'new-revision'), { ...draft, providerIdentifier: f.connection.id, body: updatedBody }) as any;
  const revision = (await f.card(updated.message_id)).draft.verification.revision;
  expect(revision?.baselineMessageId).toBe(baseline.message_id);
  expect(revision.body.map((part: any) => part.text).join('')).toBe(updatedBody);
  expect(revision.body.filter((part: any) => part.added).map((part: any) => part.text).join('')).toContain('Tuesday');
 } finally { await f.cleanup(); }
});

test('valid completed connector envelopes recover the reviewed recipients and content exactly once', async () => {
 if (!databaseUrl) return;
 const replies = [
  'synthetic-sent-id',
  JSON.stringify({ id: 'synthetic-sent-id' }),
  { id: 'synthetic-sent-id' },
  { structuredContent: { id: 'synthetic-sent-id' }, content: [{ type: 'text', text: 'Summary only' }] },
  { content: [{ type: 'text', text: JSON.stringify({ id: 'synthetic-sent-id' }) }] },
  { accepted: ['reviewed@example.com', 'copied@example.com'], rejected: [], messageId: 'synthetic-message-id' },
 ];
 for (const variant of ['control', 'treatment'] as const) for (const result of replies) {
  const f = await notificationExperiment(variant);
  try {
   const id = await f.create(0);
   await Effect.runPromise(f.service.mutate(id, { action: 'save', edits: { to: ['reviewed@example.com'], cc: ['copied@example.com'], subject: 'Reviewed subject', body: 'Reviewed body' } }));
   const stored = await f.card(id);
   await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: new Date().toISOString(), sendAttemptId: crypto.randomUUID() } } });
   await f.prisma.pluginInvocation.create({ data: { callId: `draft-send:${id}:send`, connectionId: f.connection.id, botId: f.botId, runId: stored.draft.runId, toolName: 'send_reviewed_email', arguments: { action: 'send' }, status: 'completed', result } });
   await Effect.runPromise(f.service.mutate(id, { action: 'refresh' }));
   const recovered = await f.card(id);
   expect(recovered.cardState).toBe('sent');
   expect(recovered.outcomeText).toContain('To: reviewed@example.com\nCc: copied@example.com\nSubject: Reviewed subject\n\nReviewed body');
   await Promise.all(['send', 'refresh', 'cancel'].map(action => Effect.runPromise(f.service.mutate(id, { action }))));
   expect((await f.card(id)).outcomeId).toBe(recovered.outcomeId); expect(f.mailSends()).toBe(0);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(1);
  } finally { await f.cleanup(); }
 }
}, 30_000);

test('a draft creation retry cannot borrow a card from an earlier run', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('treatment');
 try {
  const firstRun = await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } });
  const draft = { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Original request', body: 'Original body' };
  const first = await f.service.create(f.context(firstRun.id, 'reused-call-id'), draft) as any;
  await f.prisma.run.update({ where: { id: firstRun.id }, data: { status: 'completed' } });
  const next = await f.prisma.run.create({ data: { botId: f.botId, conversationId: firstRun.conversationId, channelId: firstRun.channelId, userMessageId: crypto.randomUUID(), status: 'running' } });
  await expect(f.service.create(f.context(next.id, 'reused-call-id'), { ...draft, to: ['different@example.com'], body: 'A different request' })).rejects.toThrow('another run');
  expect((await f.card(first.message_id)).draft.to).toEqual(['ann@example.com']);
  expect(await f.prisma.channelMessage.count({ where: { senderBotId: f.botId, metadata: { path: ['type'], equals: 'external-draft' } } })).toBe(1);
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});

test('legacy route recovery ignores non-verification tool receipts', async () => {
 if (!databaseUrl) return;
 for (const fake of ['wrong-tool', 'send-action', 'failed-verify', 'missing-identity'] as const) {
  const f = await notificationExperiment('treatment');
  const sends: any[] = [];
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
   sends.push(input); return { id: 'synthetic-only' };
  } } as never);
  try {
   await f.prisma.pluginConnection.update({ where: { id: f.connection.id }, data: { name: `Unique legacy ${crypto.randomUUID()}` } });
   const namespace = (await loadConnectionNamespaces(f.prisma)).get(f.connection.id)!;
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   const card = await service.create(f.context(runId, 'legacy-proof'), { platform: 'email', providerIdentifier: namespace, from: 'me@example.com', to: ['ann@example.com'], subject: 'Legacy proof', body: 'Do not guess the account' }) as any;
   const stored = await f.card(card.message_id);
   await f.prisma.channelMessage.update({ where: { id: card.message_id }, data: { metadata: { ...stored, draft: { ...stored.draft, providerIdentifier: namespace } } } });
   const toolName = fake === 'wrong-tool' ? 'unrelated_read' : 'send_reviewed_email';
   await f.prisma.pluginInvocation.create({ data: { callId: `draft-verify:legacy-proof:${toolName}`, connectionId: f.connection.id, botId: f.botId, runId, toolName, arguments: { action: fake === 'send-action' ? 'send' : 'verify' }, status: 'completed', result: fake === 'failed-verify' ? { isError: true, content: [{ type: 'text', text: 'Verification failed' }] } : fake === 'missing-identity' ? { unrelated: 'not a verification result' } : { identity: 'me@example.com' } } });
   await Effect.runPromise(service.mutate(card.message_id, { action: 'send' }));
   expect(sends).toHaveLength(0);
   expect((await f.card(card.message_id)).cardState).toBe('pending');
   expect((await f.card(card.message_id)).sendError).toContain('original account');
  } finally { await f.cleanup(); }
 }
});

test('live and recovered reviewed email require a complete send confirmation', async () => {
 if (!databaseUrl) return;
 const replies = ['false', 'null', 'true', { structuredContent: null }, { content: null }, { isError: false }, { unrelated: 'not a send receipt' },
  { messageId: 'synthetic-partial', accepted: ['ann@example.com'], rejected: ['bob@example.com'] },
  { messageId: 'synthetic-omitted-cc', accepted: ['ann@example.com', 'bob@example.com'], rejected: [] }];
 for (const phase of ['review', 'automatic', 'recovery'] as const) for (const result of replies) {
  const f = await notificationExperiment('treatment'); let attempts = 0;
  const service = new ExternalDraftService(f.prisma, f.messaging, { invoke: async (input: any) => {
   if (input.arguments.action === 'verify') return { identity: 'me@example.com' };
   attempts++; return result;
  } } as never, { treatmentPercent: '100' });
  try {
   const runId = (await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } })).id;
   await f.prisma.bot.update({ where: { id: f.botId }, data: { draftingDisabled: phase === 'automatic' } });
   const created = await service.create(f.context(runId, 'complete-confirmation'), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: ['ann@example.com', 'bob@example.com'], cc: ['copied@example.com'], subject: 'Whole reviewed message', body: 'Synthetic only' }) as any;
   const id = created.message_id;
   if (phase === 'automatic') expect(created.delivery).toBe('unknown');
   else if (phase === 'review') await Effect.runPromise(service.mutate(id, { action: 'send' }));
   else {
    const stored = await f.card(id);
    await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: new Date().toISOString(), sendAttemptId: crypto.randomUUID() } } });
    await f.prisma.pluginInvocation.create({ data: { callId: `draft-send:${id}:send`, connectionId: f.connection.id, botId: f.botId, runId, toolName: 'send_reviewed_email', arguments: { action: 'send' }, status: 'completed', result } });
    await Effect.runPromise(service.mutate(id, { action: 'refresh' }));
   }
   const settled = await f.card(id); expect(settled.cardState).toBe('unknown');
   expect(settled.outcomeText).toContain('may or may not have gone out');
   await Promise.all(['send', 'refresh', 'cancel'].map(action => Effect.runPromise(service.mutate(id, { action }))));
   expect(attempts).toBe(phase === 'recovery' ? 0 : 1);
   expect((await f.card(id)).outcomeId).toBe(settled.outcomeId);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(0);
  } finally { await f.cleanup(); }
 }
}, 30_000);

test('original incident: 24 distinct reviewed sends queue behind a busy foreground turn and continue once', async () => {
 if (!databaseUrl) return;
 const { PluginInvocations } = await import('../src/services/plugin/invocations');
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant); let attempts = 0;
  const plugins = new PluginInvocations(f.prisma, async callId => {
   const call = await f.prisma.pluginInvocation.findUniqueOrThrow({ where: { callId } });
   const result = (call.arguments as any).action === 'verify' ? { identity: 'me@example.com' } : { id: `synthetic-distinct-${++attempts}`, labelIds: ['SENT'] };
   await f.prisma.pluginInvocation.update({ where: { callId }, data: { status: 'completed', result, completedAt: new Date() } }); return result;
  });
  const service = new ExternalDraftService(f.prisma, f.messaging, plugins as never, { treatmentPercent: variant === 'treatment' ? '100' : '0' });
  try {
   const foreground = await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } });
   await f.prisma.botRunLease.create({ data: { botId: f.botId, runId: foreground.id, scope: 'foreground', ownerId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 120_000) } });
   const ids: string[] = [];
   for (let i = 0; i < 24; i++) {
    const created = await service.create(f.context(foreground.id, `original-24-${i}`), { platform: 'email', providerIdentifier: f.connection.id, from: 'me@example.com', to: [`provider${i}@example.com`], cc: ['copy1@example.com', 'copy2@example.com'], subject: 'Original incident synthetic replay', body: `Reviewed content ${i}`, waitForReview: true }) as any;
    ids.push(created.message_id);
   }
   for (const group of [ids.slice(0, 21), ids.slice(21, 23), ids.slice(23)]) {
    for (const id of group) await Effect.runPromise(service.mutate(id, { action: 'send' }));
    expect(await f.worker().claim(f.botId)).toBeNull();
   }
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response', status: 'pending' } })).toBe(variant === 'control' ? 24 : 1);
   await f.prisma.botRunLease.deleteMany({ where: { botId: f.botId } });
   await f.prisma.run.update({ where: { id: foreground.id }, data: { status: 'completed', completedAt: new Date() } });
   await f.ready(); const claimed = await f.worker().claim(f.botId); expect(claimed).toBeTruthy();
   expect(claimed.content).toContain('The platform handles the status acknowledgement');
   await f.messaging.flushDraftNotification(f.context(claimed.runId));
   const content = (await f.visible())[0]!.content;
   await f.messaging.sendVisible(f.context(claimed.runId, 'one-outcome-reply'), { type: 'text', content, end_turn: true });
   expect(await f.visible()).toHaveLength(1);
   await f.release(claimed); expect(await f.worker().claim(f.botId)).toBeNull();
   const records = await f.prisma.pluginInvocation.findMany({ where: { botId: f.botId, arguments: { path: ['action'], equals: 'send' } } });
   expect(records).toHaveLength(24); expect(attempts).toBe(24);
   expect(await f.prisma.pluginInvocation.count({ where: { botId: f.botId, arguments: { path: ['action'], equals: 'verify' } } })).toBe(48);
   expect(new Set(records.map(row => (row.result as any).id)).size).toBe(24);
   expect(new Set(records.map(row => (row.arguments as any).draft.to[0])).size).toBe(24);
   for (const id of ids) expect(await f.card(id)).toMatchObject({ cardState: 'sent', outcomeId: expect.any(String) });
   for (const row of records) expect((row.arguments as any).draft.cc).toEqual(['copy1@example.com', 'copy2@example.com']);
  } finally { await f.cleanup(); }
 }
}, 30_000);


test('server restart preserves managed draft receipts and pending follow-up work', async () => {
 if (!databaseUrl) return;
 const { recover } = await import('../src/services/startup-recovery');
 for (const variant of ['control', 'treatment'] as const) for (const published of [false, true]) {
  const f = await notificationExperiment(variant);
  try {
   await f.prisma.run.updateMany({ where: { botId: f.botId }, data: { status: 'completed' } });
   const id = await f.create(0); await f.settle(id, 'cancel'); await f.ready();
   const claimed = await f.worker().claim(f.botId);
   expect(claimed).not.toBeNull();
   const oldPayload = (await f.prisma.inboxEvent.findUniqueOrThrow({ where: { id: claimed.inboxId } })).payload as any;
   if (published) await f.messaging.flushDraftNotification(f.context(claimed.runId));
   expect(await f.visible()).toHaveLength(published ? 1 : 0);
   const restart = () => recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
   await restart(); await restart();
   const recovered = await f.prisma.inboxEvent.findMany({ where: { botId: f.botId, status: 'pending' } });
   expect(recovered).toHaveLength(1);
   expect(recovered[0]!.type).toBe('draft.response');
   expect((recovered[0]!.payload as any).draftNotification).toEqual(oldPayload.draftNotification);
   const resumed = await f.worker().claim(f.botId);
   expect(resumed).not.toBeNull();
   const { Projection } = await import('../../worker/src/projection');
   await f.messaging.agentData.writeInferenceSettings({ providerId: 'openai-codex', modelId: 'synthetic-fixture', reasoning: 'low' });
   const dispatched: any[] = [], failures: unknown[] = [];
   const computer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/v1/context-sessions/')) return Response.json({ type: 'context.state', contextSessionId: path.split('/').at(-1), epoch: 0, archives: [] });
    if (path === '/v1/task-capabilities') return Response.json({ desktopAvailable: true, boxAvailable: true });
    if (path !== '/v1/turns') return new Response(null, { status: 404 });
    const input = await request.json() as any; dispatched.push(input);
    expect(input.requestSource).toBe('event');
    expect(input.draftStatusAcknowledged).toBe(true);
    expect(input.content).toContain((await f.visible())[0]!.content);
    expect(input.content).toContain('Current draft state at dispatch:');
    expect(await f.visible()).toHaveLength(1);
    return new Response(new ReadableStream({ start(controller) {
     const write = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
     write({ type: 'turn.started', turnId: input.runId });
     void (async () => {
      // Recovery still delivers useful requested work after its status acknowledgement.
      await f.messaging.sendVisible(f.context(input.runId), { type: 'text', content: 'Would you like a different recipient?' });
      write({ type: 'prompt.delivered', turnId: input.runId });
      write({ type: 'turn.completed', turnId: input.runId, status: 'completed' }); controller.close();
     })().catch(error => controller.error(error));
    } }), { headers: { 'content-type': 'application/x-ndjson' } });
   } });
   try {
    const worker = Object.assign(f.worker(), { agentData: f.messaging.agentData, computerUrl: computer.url.origin,
     controlToken: 'synthetic-draft-test', projection: new Projection(f.prisma, f.messaging.agentData), pushNotifications: { drain: async () => {} } });
    const fail = worker.fail.bind(worker);
    worker.fail = async (...args: any[]) => { failures.push(args[1]); return fail(...args); };
    await worker.execute(resumed);
    expect(failures).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(await f.visible()).toHaveLength(2);
    expect((await f.card(id)).draftNotification.messageId).toBe((await f.visible())[0]!.id);
    expect(f.mailSends()).toBe(0);
    expect((await f.prisma.run.findUniqueOrThrow({ where: { id: resumed.runId } })).status).toBe('completed');
   } finally { computer.stop(true); }
   expect(await f.worker().claim(f.botId)).toBeNull();
  } finally { await f.cleanup(); }
 }
});

test('server restart keeps draft recovery bounded and fences replies from interrupted attempts', async () => {
 if (!databaseUrl) return;
 const { recover } = await import('../src/services/startup-recovery');
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   await f.prisma.run.updateMany({ where: { botId: f.botId }, data: { status: 'completed' } });
   for (let i = 0; i < 2; i++) await f.settle(await f.create(i), i % 2 ? 'send' : 'cancel');
   await f.ready();
   let current = await f.worker().claim(f.botId);
   const rootRunId = current.runId;
   await f.messaging.flushDraftNotification(f.context(current.runId));
   for (let attempt = 0; attempt < 3; attempt++) {
    const interrupted = current;
    await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
    // An old computer must not add a late acknowledgement after cancellation.
    const late = await f.messaging.sendVisible(f.context(interrupted.runId), { type: 'text', content: 'Obsolete status confirmation' });
    expect(late).toMatchObject({ acknowledgement: { sent: false } });
    expect((await f.visible()).some(message => message.content === 'Obsolete status confirmation')).toBe(false);
    const pending = await f.prisma.inboxEvent.findMany({ where: { botId: f.botId, status: 'pending' } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.idempotencyKey).toBe(`runtime-recovery:${rootRunId}:${attempt + 1}`);
    expect(pending[0]!.type).toBe('draft.response');
    current = await f.worker().claim(f.botId);
    expect(current).not.toBeNull();
    expect(current.content).toContain('Do not');
    {
     expect((await f.messaging.flushDraftNotification(f.context(current.runId)))?.acknowledgement.sent).toBe(true);
     expect(await f.visible()).toHaveLength(1);
    }
   }
   await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
   await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, status: 'pending' } })).toBe(0);
   expect(await f.worker().claim(f.botId)).toBeNull();
   expect(await f.prisma.channelMessage.count({ where: { channelId: f.context('').channelId, sender: 'system' } })).toBe(1);
   expect(f.mailSends()).toBe(1);
   for (const id of f.ids) expect((await f.card(id)).cardState).toBe(f.ids.indexOf(id) % 2 ? 'sent' : 'dismissed');
  } finally { await f.cleanup(); }
 }
});

test('recovered receipt does not absorb an unrelated draft settled after the restart', async () => {
 if (!databaseUrl) return;
 const { recover } = await import('../src/services/startup-recovery');
 const f = await notificationExperiment('treatment');
 try {
  await f.prisma.run.updateMany({ where: { botId: f.botId }, data: { status: 'completed' } });
  const first = await f.create(0); await f.settle(first, 'cancel'); await f.ready();
  const initial = await f.worker().claim(f.botId);
  await f.messaging.flushDraftNotification(f.context(initial.runId));
  const firstReceipt = (await f.card(first)).draftNotification.messageId;
  await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
  const recovered = await f.worker().claim(f.botId);
  const second = await f.create(1); await f.settle(second, 'cancel'); await f.ready();
  const duplicate = await f.messaging.flushDraftNotification(f.context(recovered.runId));
  expect(duplicate?.acknowledgement).toMatchObject({ sent: true, message_id: firstReceipt, duplicate: true });
  expect((await f.card(second)).draftNotification.messageId).toBeUndefined();
  await f.release(recovered);
  const next = await f.worker().claim(f.botId);
  expect(next).not.toBeNull();
  await f.messaging.flushDraftNotification(f.context(next.runId));
  expect((await f.card(second)).draftNotification.messageId).toBeDefined();
  expect(await f.visible()).toHaveLength(2);
  expect(f.mailSends()).toBe(0);
  await f.release(next);
  expect(await f.worker().claim(f.botId)).toBeNull();
 } finally { await f.cleanup(); }
});

test('server restart does not revive draft work in an archived chat', async () => {
 if (!databaseUrl) return;
 const { recover } = await import('../src/services/startup-recovery');
 for (const variant of ['control', 'treatment'] as const) {
  const f = await notificationExperiment(variant);
  try {
   await f.prisma.run.updateMany({ where: { botId: f.botId }, data: { status: 'completed' } });
   const id = await f.create(0); await f.settle(id, 'cancel'); await f.ready();
   const claimed = await f.worker().claim(f.botId);
   await f.prisma.channel.update({ where: { id: claimed.channelId }, data: { archivedAt: new Date() } });
   await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, status: 'pending' } })).toBe(0);
   expect(await f.worker().claim(f.botId)).toBeNull();
   expect(await f.visible()).toHaveLength(0);
   expect(f.mailSends()).toBe(0);
   expect((await f.card(id)).cardState).toBe('dismissed');
  } finally { await f.cleanup(); }
 }
});

test('actual server recovery never replays reviewed sends from running or completed drafting turns', async () => {
 if (!databaseUrl) return;
 const { recover } = await import('../src/services/startup-recovery');
 for (const sourceStatus of ['running', 'completed'] as const) for (const confirmed of [false, true]) {
  const f = await notificationExperiment('treatment');
  try {
   const source = await f.prisma.run.findFirstOrThrow({ where: { botId: f.botId } });
   await f.prisma.run.update({ where: { id: source.id }, data: { status: sourceStatus } });
   const id = await f.create(0), stored = await f.card(id);
   const startedAt = new Date(Date.now() - 181_000);
   await f.prisma.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: startedAt.toISOString(), sendAttemptId: crypto.randomUUID() } } });
   await f.prisma.pluginInvocation.create({ data: { connectionId: f.connection.id, botId: f.botId, runId: source.id,
    callId: `draft-send:${id}:send`, toolName: 'send_reviewed_email', arguments: { action: 'send', draft: stored.draft }, startedAt,
    ...(confirmed ? { status: 'completed', result: { id: 'already-sent-before-restart' }, completedAt: new Date() } : { error: 'Executing' }) } });
   await recover(f.prisma, { send: async () => crypto.randomUUID() } as never, f.messaging, async () => new Response());
   await Promise.all(['refresh', 'send', 'cancel'].map(action => Effect.runPromise(f.service.mutate(id, { action }))));
   const settled = await f.card(id);
   expect(settled.cardState).toBe(confirmed ? 'sent' : 'unknown');
   expect(settled.outcomeId).toBeDefined();
   if (!confirmed) expect(settled.outcomeText).toContain('may or may not have gone out');
   await Promise.all(['refresh', 'send', 'cancel'].map(action => Effect.runPromise(f.service.mutate(id, { action }))));
   expect((await f.card(id)).outcomeId).toBe(settled.outcomeId);
   expect(f.mailSends()).toBe(0);
   expect(await f.prisma.pluginInvocation.count({ where: { botId: f.botId, arguments: { path: ['action'], equals: 'send' } } })).toBe(1);
   expect(await f.prisma.inboxEvent.count({ where: { botId: f.botId, type: 'draft.response' } })).toBe(confirmed ? 1 : 0);
  } finally { await f.cleanup(); }
 }
});

test('managed default acknowledgements leave legacy untagged history and wakes on their original path', async () => {
 if (!databaseUrl) return;
 const f = await notificationExperiment('control');
 try {
  const legacy = await f.create(0); await f.settle(legacy, 'cancel');
  const oldCard = await f.card(legacy); delete oldCard.draftNotification;
  await f.prisma.channelMessage.update({ where: { id: legacy }, data: { metadata: oldCard } });
  const oldWake = await f.prisma.inboxEvent.findFirstOrThrow({ where: { botId: f.botId, type: 'draft.response' } });
  const oldPayload = oldWake.payload as any; delete oldPayload.draftNotification;
  await f.prisma.inboxEvent.update({ where: { id: oldWake.id }, data: { payload: oldPayload } });
  const managed = await f.create(1); await f.settle(managed, 'cancel'); await f.ready();
  const first = await f.worker().claim(f.botId);
  expect(first.inboxId).toBe(oldWake.id);
  expect(first.content).toContain('1 external message draft outcome(s)');
  expect(await f.messaging.flushDraftNotification(f.context(first.runId))).toBeNull();
  expect(await f.visible()).toHaveLength(0);
  await f.release(first);
  const next = await f.worker().claim(f.botId);
  expect(next).not.toBeNull();
  await f.messaging.flushDraftNotification(f.context(next.runId));
  expect(await f.visible()).toHaveLength(1);
  expect((await f.card(managed)).draftNotification.messageId).toBe((await f.visible())[0]!.id);
  expect((await f.card(legacy)).draftNotification).toBeUndefined();
  expect(((await f.visible())[0]!.metadata as any).draftOutcomeNotification.outcomeIds).toEqual([(await f.card(managed)).outcomeId]);
  await f.release(next); expect(await f.worker().claim(f.botId)).toBeNull();
  expect(f.mailSends()).toBe(0);
 } finally { await f.cleanup(); }
});
