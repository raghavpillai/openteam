import { expect } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { createPrismaClient } from '@openteam/db';
import { AgentMessaging, lockAgentLifecycle, publishDraftNotification } from '@openteam/messaging';
import { renderControlResult } from '@openteam/contracts/tool-results';
import { ExternalDraftService } from '../src/services/external-draft-service';
import { RunService } from '../src/services/run-service';
import { recover } from '../src/services/startup-recovery';
import { PluginInvocations } from '../src/services/plugin/invocations';
import { loadConnectionNamespaces } from '../src/services/plugin/namespaces';
import { Projection } from '../../worker/src/projection';
import { bareWorker, databaseUrl, dbIt, gate, type Db, type Harness } from './harness';

type Invoke = (input: any) => Promise<unknown>;
const verified: Invoke = async input => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: 'sent' };

/** A Bot chat plus a connector account that declares reviewed sending. */
async function fixture(h: Harness, invoke: Invoke = verified, treatment = false) {
 const pluginKey = `mail-${crypto.randomUUID().slice(0, 8)}`;
 const installation = await h.db.pluginInstallation.create({ data: { pluginKey, version: '1.0.0', name: 'Mail', publisher: 'Test', manifest: { key: pluginKey, name: 'Mail', skills: [], connections: [{ key: 'email', transport: 'stdio', drafts: { platform: 'email', tool: 'send_reviewed_email' } }] } } });
 h.onClose(() => h.db.pluginInstallation.deleteMany({ where: { pluginKey } }));
 const connection = await h.db.pluginConnection.create({ data: { installationId: installation.id, connectorKey: 'email', name: 'Mail', transport: 'stdio', authType: 'none', status: 'ready' } });
 const bot = await h.bot('Drafts');
 const contextId = (await h.db.contextSession.create({ data: { botId: bot.id, scope: 'home', scopeId: bot.conversationId } })).id;
 const run = await h.run(bot);
 const context = (callId: string = crypto.randomUUID(), runId = run.id) => h.context(bot, { runId, callId });
 const service = new ExternalDraftService(h.db, h.messaging, { invoke } as never, { treatmentPercent: treatment ? '100' : '0' });
 const using = (other: Invoke | PluginInvocations) => new ExternalDraftService(h.db, h.messaging, (typeof other === 'function' ? { invoke: other } : other) as never, { treatmentPercent: treatment ? '100' : '0' });
 const card = async (id: string) => (await h.db.channelMessage.findUniqueOrThrow({ where: { id } })).metadata as any;
 const draft = { platform: 'email', providerIdentifier: connection.id, from: 'me@example.com', to: ['ann@example.com'], subject: 'Hello', body: 'Hi Ann' };
 const create = async (callId: string = crypto.randomUUID(), overrides: Record<string, unknown> = {}, on = service) => await on.create(context(callId), { ...draft, ...overrides }) as Record<string, any>;
 const settle = (id: string, action: string, edits?: Record<string, unknown>, on = service) => Effect.runPromise(on.mutate(id, { action, ...(edits ? { edits } : {}) } as never)) as Promise<any>;
 const worker = () => bareWorker({ prisma: h.db, messaging: h.messaging, workspaceRoot: h.dir, memoryReviews: new Map() });
 const ready = () => h.db.inboxEvent.updateMany({ where: { botId: bot.id, type: 'draft.response', status: 'pending' }, data: { availableAt: new Date(0) } });
 const claim = async () => { await ready(); return await worker().claim(bot.id); };
 const release = async (claimed: any) => {
  await h.db.botRunLease.deleteMany({ where: { botId: bot.id } });
  await h.db.inboxEvent.update({ where: { id: claimed.inboxId }, data: { status: 'completed' } });
  await h.db.run.update({ where: { id: claimed.runId }, data: { status: 'completed' } });
 };
 const visible = () => h.db.channelMessage.findMany({ where: { channelId: bot.channelId!, senderBotId: bot.id, metadata: { path: ['type'], equals: 'text' } }, orderBy: { sequence: 'asc' } });
 const wakes = (status?: 'pending') => h.db.inboxEvent.count({ where: { botId: bot.id, type: 'draft.response', ...(status ? { status } : {}) } });
 /** Marks a card as mid-send with a connector receipt already stored, as a crash would leave it. */
 const interrupted = async (id: string, receipt: Record<string, unknown>, startedAt = new Date()) => {
  const stored = await card(id);
  await h.db.channelMessage.update({ where: { id }, data: { metadata: { ...stored, cardState: 'sending', sendStartedAt: startedAt.toISOString(), sendAttemptId: crypto.randomUUID() } } });
  await h.db.pluginInvocation.create({ data: { callId: `draft-send:${id}:send`, connectionId: connection.id, botId: bot.id, runId: stored.draft.runId, toolName: 'send_reviewed_email', arguments: { action: 'send', draft: stored.draft }, startedAt, ...receipt } as never });
 };
 /** Keeps a status row inside its progress-update idle window however slow the host is. */
 const recent = async () => {
  for (const row of await visible()) {
   const metadata = row.metadata as any;
   if (metadata.draftOutcomeNotification) await h.db.channelMessage.update({ where: { id: row.id }, data: { metadata: { ...metadata, draftOutcomeNotification: { ...metadata.draftOutcomeNotification, updatedAt: new Date().toISOString() } } } });
  }
 };
 /** Pretends the send began long enough ago to have timed out. */
 const expire = async (id: string) => h.db.channelMessage.update({ where: { id }, data: { metadata: { ...await card(id), sendStartedAt: new Date(Date.now() - 181_000).toISOString() } } });
 return { bot, run, contextId, connection, context, service, using, card, draft, create, settle, worker, claim, release, visible, wakes, recent, interrupted, expire };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A computer host that accepts each turn's stream before `onTurn` runs, like the real one. */
async function computer(h: Harness, f: Fixture, onTurn: (input: any) => Promise<void> = async () => {}) {
 const state = { outage: false, dispatched: [] as any[], failures: [] as unknown[] };
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (state.outage) return new Response('Injected computer outage', { status: 503 });
  if (path.startsWith('/v1/context-sessions/')) return Response.json({ type: 'context.state', contextSessionId: path.split('/').at(-1), epoch: 0, archives: [] });
  if (path === '/v1/task-capabilities') return Response.json({ desktopAvailable: true, boxAvailable: true });
  if (path !== '/v1/turns') return new Response(null, { status: 404 });
  const input = await request.json() as any;
  state.dispatched.push({ ...input, visibleAtDispatch: (await f.visible()).length });
  return new Response(new ReadableStream({ start(controller) {
   const write = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
   write({ type: 'turn.started', turnId: input.runId });
   void onTurn(input).then(() => {
    write({ type: 'prompt.delivered', turnId: input.runId });
    write({ type: 'turn.completed', turnId: input.runId, status: 'completed' }); controller.close();
   }, error => controller.error(error));
  } }), { headers: { 'content-type': 'application/x-ndjson' } });
 } });
 h.onClose(async () => server.stop(true));
 await h.store.writeInferenceSettings({ providerId: 'openai-codex', modelId: 'synthetic-fixture', reasoning: 'low' });
 const worker = Object.assign(f.worker(), { agentData: h.store, computerUrl: server.url.origin, controlToken: 'synthetic',
  projection: new Projection(h.db, h.store), pushNotifications: { drain: async () => {} } });
 const fail = worker.fail.bind(worker);
 worker.fail = async (...args: any[]) => { state.failures.push(args[1]); return fail(...args); };
 return Object.assign(state, { worker });
}

/** A signed-in iOS device, so published statuses queue a push. */
async function pushDevice(h: Harness, f: Fixture) {
 const userId = crypto.randomUUID();
 await h.db.user.create({ data: { id: userId, name: 'Draft push fixture', email: `${userId}@openteam.invalid` } });
 const session = await h.db.session.create({ data: { id: crypto.randomUUID(), userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
 const device = await h.db.pushDevice.create({ data: { installationId: crypto.randomUUID(), platform: 'ios', pushToken: crypto.randomUUID(), authSessionId: session.id, authRequired: process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() !== 'disabled' } });
 h.onClose(async () => { await h.db.outboxDelivery.deleteMany({ where: { target: device.id } }); await h.db.pushDevice.deleteMany({ where: { id: device.id } }); await h.db.user.deleteMany({ where: { id: userId } }); });
 return { target: device.id, payload: { path: ['channelId'], equals: f.bot.channelId! } };
}

/** Polls until a query waits on the advisory lock `key`, with room for a slow host. */
async function advisoryWaiter(db: Db, key: string) {
 for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(10)) {
  const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND objid = (hashtext(${key})::bigint & 4294967295)::oid AND NOT granted) AS waiting`;
  if (rows[0]?.waiting) return true;
 }
 return false;
}

const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));

dbIt('reviewed sending verifies routing, sends each card at most once and honours approval rules', async (h) => {
 const calls: any[] = []; let identity = 'me@example.com'; let fail: 'before' | 'after' | null = null;
 const f = await fixture(h, async (input) => {
  calls.push(input);
  if (input.arguments.action === 'verify') {
   if (fail === 'before') throw new Error('Mail server unreachable');
   return { identity, sendingAddresses: ['me@example.com', 'alias@example.com'], signatures: { 'alias@example.com': '<b>Alias</b>', 'stranger@example.com': 'x' }, thread: '“Invoice question” from Ann' };
  }
  if (fail === 'after') throw new Error('Connection lost after remote side effect');
  return { id: 'sent-1' };
 });
 const sends = () => calls.filter(call => call.arguments.action === 'send');
 const reply = { from: 'Me@Example.com', subject: 'Re: Invoice question', body: 'It is $1,250.', replyToMessageId: 'msg-42' };

 const card = await f.create('reply-a', reply);
 expect(calls[0]).toMatchObject({ connectionId: f.connection.id, toolName: 'send_reviewed_email', hostTool: true, arguments: { action: 'verify' } });
 expect((await f.card(card.message_id)).draft.verification.signatures).toEqual({ 'alias@example.com': '<b>Alias</b>' });
 await expect(f.settle(card.message_id, 'send', { providerIdentifier: 'different' })).rejects.toThrow('cannot be changed');
 await expect(f.settle(card.message_id, 'send', { from: 'stranger@example.com' })).rejects.toThrow('verified addresses');
 // Both racing sends must see the saved review edits; lock order is unspecified.
 const edits = { from: 'alias@example.com', body: 'Thanks!', cc: ['bob@example.com'] };
 await f.settle(card.message_id, 'save', edits);
 await Promise.all([f.settle(card.message_id, 'send', edits), f.settle(card.message_id, 'send')]);
 expect(sends()).toHaveLength(1);
 expect(sends()[0]).toMatchObject({ callId: `draft-send:${card.message_id}:send`, arguments: { draft: { ...edits, replyToMessageId: 'msg-42', signatureHtml: '<b>Alias</b>' } } });
 expect((await f.card(card.message_id)).outcomeText).toStartWith('The user sent the reviewed message.\n\nFrom: alias@example.com');
 expect(await f.wakes()).toBe(1);

 // Nothing went out: the card stays editable and says why.
 const retry = await f.create('reply-b');
 fail = 'before';
 expect((await f.settle(retry.message_id, 'send')).message.metadata).toMatchObject({ cardState: 'pending', sendError: 'Mail server unreachable' });
 // An unconfirmed send is never retried; a discard wakes the Bot exactly once and reaches its next turn.
 fail = null;
 const unknown = await f.create('reply-c');
 fail = 'after';
 expect((await f.settle(unknown.message_id, 'send')).message.metadata).toMatchObject({ cardState: 'unknown' });
 const before = calls.length;
 await f.settle(unknown.message_id, 'send');
 expect(calls).toHaveLength(before);
 fail = null;
 const discarded = await f.create('reply-d');
 const wakesBefore = await f.wakes();
 await f.settle(discarded.message_id, 'cancel'); await f.settle(discarded.message_id, 'cancel');
 expect(await f.wakes()).toBe(wakesBefore + 1);
 expect(JSON.stringify(await h.messaging.platformPrompt(f.bot.id, f.contextId, '', null))).toContain('The user discarded your draft without sending.');

 // Routing is re-verified: a changed identity fails the send and refuses new drafts from the old address.
 const stale = await f.create('reply-e');
 identity = 'someone-else@example.com';
 expect((await f.settle(stale.message_id, 'send')).message.metadata).toMatchObject({ cardState: 'failed' });
 await expect(f.create('reply-f', { from: 'nobody@example.com' })).rejects.toThrow('is not the address this account really sends as');
 identity = 'me@example.com';
 await expect(f.create('reply-g', { providerIdentifier: 'not-a-connection' })).rejects.toThrow("can't send reviewed email");
 const namespace = (await loadConnectionNamespaces(h.db)).get(f.connection.id)!;
 await f.create('reply-h', { providerIdentifier: namespace });
 expect(calls.at(-1)).toMatchObject({ connectionId: f.connection.id });

 // Attachments send the previewed bytes, not whatever the file holds at send time; missing or tampered copies refuse.
 const path = join(h.dir, 'review.txt');
 await writeFile(path, 'These are the reviewed bytes.');
 const files = await f.create('files-a', { attachments: [path] });
 await writeFile(path, 'The source file changed after review.');
 await f.settle(files.message_id, 'send');
 expect(Buffer.from(sends().at(-1).arguments.draft.attachments[0].content, 'base64').toString()).toBe('These are the reviewed bytes.');
 const sent = sends().length;
 for (const damage of ['missing', 'tampered'] as const) {
  const blocked = await f.create(`files-${damage}`, { attachments: [path] });
  const asset = (await f.card(blocked.message_id)).draft.verification.attachments[0];
  if (damage === 'missing') await rm(h.messaging.assets.contentPath(asset.assetId));
  else await writeFile(h.messaging.assets.contentPath(asset.assetId), 'X'.repeat(asset.byteSize));
  expect((await f.settle(blocked.message_id, 'send')).message.metadata).toMatchObject({ cardState: 'pending' });
  expect((await f.card(blocked.message_id)).outcomeId).toBeUndefined();
 }
 expect(sends()).toHaveLength(sent);

 // Approval rules: allowed recipients skip the card unless the Bot asks for review; drafts-off sends to anyone.
 const rule = await f.create('approval-a');
 await Effect.runPromise(f.service.mutate(rule.message_id, { action: 'approval', mode: 'always-allow', edits: { to: ['Ann@Example.com', 'bob@example.com'], cc: [] } } as never));
 expect((await h.db.bot.findUniqueOrThrow({ where: { id: f.bot.id } })).draftAllowedRecipients).toEqual(['ann@example.com', 'bob@example.com']);
 const allowed = await f.create('approval-b');
 expect(allowed).toMatchObject({ delivery: 'sent' });
 expect(await f.card(allowed.message_id)).toMatchObject({ cardState: 'sent', sentUnder: { rule: 'Allow recipient ann@example.com' } });
 expect((await f.create('approval-c', { waitForReview: true })).delivery).toBeUndefined();
 expect((await f.create('approval-d', { cc: ['carol@example.com'] })).delivery).toBeUndefined();
 await Effect.runPromise(f.service.mutate(allowed.message_id, { action: 'approval', mode: 'disable-drafts' } as never));
 const anyone = await f.create('approval-e', { to: ['dave@example.com'] });
 expect(await f.card(anyone.message_id)).toMatchObject({ cardState: 'sent', sentUnder: { draftingDisabled: true } });
 const total = sends().length;
 await f.create('approval-e', { to: ['dave@example.com'] });
 expect(sends()).toHaveLength(total);
 await Effect.runPromise(f.service.mutate(anyone.message_id, { action: 'approval', mode: 'needs-approval' } as never));
 expect(await h.db.bot.findUniqueOrThrow({ where: { id: f.bot.id }, select: { draftingDisabled: true, draftAllowedRecipients: true } })).toEqual({ draftingDisabled: false, draftAllowedRecipients: ['ann@example.com', 'bob@example.com'] });
});

dbIt('a retried creation call returns its one stored card without the connector, even from a room', async (h) => {
 const f = await fixture(h);
 const offline = f.using(async () => { throw new Error('Connector must not be called'); });
 // Concurrent retries agree on one card, whatever arguments they carry.
 const results = await Promise.all(['ann', 'bob', 'carol'].map(name => f.create('same-call', { to: [`${name}@example.com`], waitForReview: true })));
 const id = results[0]!.message_id;
 for (const result of results) expect(result).toMatchObject({ message_id: id, target: (await f.card(id)).draft.to[0] });
 // A lost response during a connector outage recovers the card with its later review edits.
 await f.settle(id, 'save', { to: ['reviewed@example.com'] });
 expect(await f.create('same-call', { to: ['retry@example.com'] }, offline)).toMatchObject({ duplicate: true, message_id: id, target: 'reviewed@example.com' });
 await f.settle(id, 'cancel');
 const discarded = await f.create('same-call', {}, offline);
 expect(discarded).toMatchObject({ duplicate: true, message_id: id, delivery: 'dismissed' });
 const readable = renderControlResult('DraftExternalMessage', discarded, { ...f.draft, to: ['wrong-retry@example.com'] });
 expect(readable).toContain('was discarded without sending'); expect(readable).not.toContain('wrong-retry@example.com');
 // Another run cannot borrow the card through a reused call ID.
 await h.db.run.update({ where: { id: f.run.id }, data: { status: 'completed' } });
 const next = await h.run(f.bot);
 await expect(f.service.create(f.context('same-call', next.id), f.draft)).rejects.toThrow('another run');
 expect(await h.db.channelMessage.count({ where: { senderBotId: f.bot.id, metadata: { path: ['type'], equals: 'external-draft' } } })).toBe(1);

 // A room cannot hold draft cards: the card lands in the 1:1 chat, and its retry recovers it there.
 const room = await h.channel({ kind: 'group', name: 'Room', members: { create: { botId: f.bot.id, ordinal: 0 } } });
 const inRoom = { ...f.context('room-call', next.id), channelId: room.id };
 const roomCard = await f.service.create(inRoom, f.draft) as any;
 expect(roomCard).toMatchObject({ in_dm: true });
 expect((await h.db.channelMessage.findUniqueOrThrow({ where: { id: roomCard.message_id } })).channelId).toBe(f.bot.channelId!);
 expect(renderControlResult('DraftExternalMessage', roomCard, f.draft)).toContain('in your own 1:1 chat with the user, not in this room');
 expect(await offline.create(inRoom, f.draft)).toMatchObject({ duplicate: true, message_id: roomCard.message_id, in_dm: true });
});

dbIt('batched draft outcomes publish one accurate status before dispatch, update it in place and report each outcome once', async (h) => {
 const f = await fixture(h, verified, true);
 const ids: string[] = [];
 for (let i = 0; i < 4; i++) ids.push((await f.create(`create-${i}`, { subject: `Draft ${i}` })).message_id);
 await f.settle(ids[0]!, 'send'); await f.settle(ids[1]!, 'cancel'); await f.settle(ids[2]!, 'cancel');
 // Outcomes collect into one wake.
 expect(await f.wakes('pending')).toBe(1);

 const host = await computer(h, f);
 const claimed = await f.claim();
 expect(claimed.content).toContain('The platform handles the status acknowledgement');
 await host.worker.execute(claimed);
 expect(host.failures).toEqual([]);
 expect(host.dispatched).toHaveLength(1);
 // The status exists before the computer receives the turn, so the model may finish silently.
 expect(host.dispatched[0]).toMatchObject({ visibleAtDispatch: 1, requestSource: 'event', draftStatusAcknowledged: true, draftStateRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
 expect(host.dispatched[0].content).toContain('Current draft state at dispatch:');
 for (const id of ids.slice(0, 3)) expect(host.dispatched[0].content).toContain(id);
 const [status] = await f.visible();
 expect(status!.content).toContain('1 sent, 2 discarded without sending');
 expect((status!.metadata as any).draftOutcomeNotification.counts).toMatchObject({ sent: 1, dismissed: 2, pending: 1 });
 expect((await h.db.run.findUniqueOrThrow({ where: { id: claimed.runId } })).status).toBe('completed');

 // The next outcome of the same batch updates that row, also when its flush is retried after a lost response.
 await f.settle(ids[3]!, 'cancel'); await f.recent();
 const second = await f.claim();
 const receipt = await h.messaging.flushDraftNotification(f.context(undefined, second.runId));
 expect((await h.messaging.flushDraftNotification(f.context('lost-response-retry', second.runId)))?.acknowledgement).toMatchObject({ message_id: (receipt?.acknowledgement as any).message_id, duplicate: true });
 const messages = await f.visible();
 expect(messages).toHaveLength(1);
 expect(messages[0]!.id).toBe(status!.id);
 expect(messages[0]!.content).toContain('none awaiting review');
 const covered = (messages[0]!.metadata as any).draftOutcomeNotification.outcomeIds;
 expect(covered).toHaveLength(4); expect(new Set(covered).size).toBe(4);
 for (const id of ids) expect((await f.card(id)).draftNotification.messageId).toBe(status!.id);
 await f.release(second);

 // A replayed continuation for outcomes already reported completes without running a turn.
 const replay = await h.db.$transaction(async tx => {
  const wake = await h.messaging.enqueueWake(tx, { botId: f.bot.id, channelId: f.bot.channelId!, origin: 'user', type: 'draft.response',
   content: '[SAND_HIDDEN_PROMPT]Replay.', clientId: `replay-${crypto.randomUUID()}`, priority: 400, wrapUserContent: false });
  await tx.inboxEvent.update({ where: { id: wake.inbox.id }, data: { payload: { ...(wake.inbox.payload as any),
   draftNotification: { variant: 'treatment', outcomeIds: covered } } } });
  return wake;
 });
 expect(await f.worker().claim(f.bot.id)).toBeNull();
 expect((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: replay.inbox.id } })).status).toBe('completed');

 // After a completed batch, a new outcome gets a fresh row; a computer outage still says nothing was sent.
 host.outage = true;
 await f.settle((await f.create('after-batch')).message_id, 'cancel');
 const failed = await f.claim();
 await host.worker.execute(failed);
 expect(String(host.failures[0])).toContain('Injected computer outage');
 expect(await f.visible()).toHaveLength(2);
 expect((await f.visible())[1]!.content).toContain('Nothing was sent');
 expect((await h.db.run.findUniqueOrThrow({ where: { id: failed.runId } })).status).toBe('interrupted');
});

dbIt('send receipts reuse the status only for an exact echo and stay truthful for everything else', async (h) => {
 const f = await fixture(h, verified, true);
 const ids: string[] = [];
 for (let i = 0; i < 2; i++) ids.push((await f.create(`create-${i}`, { subject: `Draft ${i}` })).message_id);
 await f.settle(ids[0]!, 'cancel');
 const claimed = await f.claim();
 await h.messaging.flushDraftNotification(f.context(undefined, claimed.runId));
 const canonical = (await f.visible())[0]!;
 const send = (content: string, extra: Record<string, unknown> = {}, callId?: string) => h.messaging.sendVisible(f.context(callId, claimed.runId), { type: 'text', content, ...extra } as never);
 expect((await send(canonical.content)).acknowledgement).toMatchObject({ sent: true, message_id: canonical.id, duplicate: true });
 for (const content of ['Would you like revisions to the remaining draft?', canonical.content + '\nWould you like revisions?']) {
  const callId = crypto.randomUUID();
  const receipt = (await send(content, {}, callId)).acknowledgement as Record<string, unknown>;
  expect(receipt).toMatchObject({ sent: true });
  expect(receipt.message_id).not.toBe(canonical.id);
  expect((await h.db.channelMessage.findUniqueOrThrow({ where: { id: String(receipt.message_id) } })).content).toBe(content);
  expect((await send(content, {}, callId)).acknowledgement).toMatchObject({ sent: true, message_id: receipt.message_id, duplicate: true });
 }
 const reply = (await send(canonical.content, { reply_to: (canonical.metadata as any).address })).acknowledgement as Record<string, unknown>;
 expect(((await h.db.channelMessage.findUniqueOrThrow({ where: { id: String(reply.message_id) } })).metadata as any).replyTo).toBe(canonical.id);
 expect(await f.visible()).toHaveLength(4);
 await h.db.run.update({ where: { id: claimed.runId }, data: { status: 'cancelled' } });
 expect((await send('A late cancelled warning.')).acknowledgement).toMatchObject({ sent: false, silent: true });
 expect(await f.visible()).toHaveLength(4);
});

dbIt('a stale draft-state revision rejects replies with a retryable receipt; a fresh one delivers once', async (h) => {
 const f = await fixture(h);
 const ids: string[] = [];
 for (let i = 0; i < 3; i++) ids.push((await f.create()).message_id);
 await f.settle(ids[0]!, 'cancel');
 const claimed = await f.claim();
 await h.messaging.flushDraftNotification(f.context(undefined, claimed.runId));
 const snapshot = await h.messaging.draftReplySnapshot(f.context(undefined, claimed.runId));
 expect(snapshot.counts.pending).toBe(2);
 const old = { ...f.context('old-question', claimed.runId), draftStateRevision: snapshot.revision };
 // Another bot's outcomes leave this bot's snapshot current.
 const other = await fixture(h);
 await other.settle((await other.create()).message_id, 'cancel');
 expect((await h.messaging.draftReplySnapshot(old)).revision).toBe(snapshot.revision);
 await Promise.all(ids.slice(1).map(id => f.settle(id, 'cancel')));
 const before = (await f.visible()).length;
 const rejected = await h.messaging.sendVisible(old, { type: 'text', content: 'Would you like revisions to the remaining drafts?', end_turn: true });
 expect(rejected.acknowledgement).toMatchObject({ sent: false, delivery_failed: true, retryable: true, reason: 'draft_state_changed', draft_state: { pending: 0 } });
 const widget = await h.messaging.sendVisible({ ...old, callId: 'old-widget' }, { type: 'widget', widget: { prompt: 'Revise the remaining drafts?', options: [{ label: 'Revise', value: 'revise' }] } });
 expect(widget.acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed' });
 // An already-emitted sibling does not acquire the fresh state merely because another call was rejected.
 const warning = 'Disk check failed. Please pause large downloads.';
 expect((await h.messaging.sendVisible({ ...old, callId: 'old-warning' }, { type: 'text', content: warning })).acknowledgement).toMatchObject({ sent: false, reason: 'draft_state_changed' });
 expect(await f.visible()).toHaveLength(before);
 expect(await h.db.channelMessage.count({ where: { channelId: f.bot.channelId!, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
 const fresh = { ...f.context('fresh-warning', claimed.runId), draftStateRevision: (rejected.acknowledgement as any).draft_state_revision };
 const delivered = await h.messaging.sendVisible(fresh, { type: 'text', content: warning });
 expect(delivered.acknowledgement).toMatchObject({ sent: true });
 // A lost success response keeps its own receipt even after the state changes again.
 await f.create();
 expect((await h.messaging.sendVisible(fresh, { type: 'text', content: warning })).acknowledgement)
  .toMatchObject({ sent: true, duplicate: true, message_id: (delivered.acknowledgement as any).message_id });
});

dbIt('a change during platform-context preparation cannot authorize a reply based on the old context', async (h) => {
 const f = await fixture(h, verified, true);
 const ids: string[] = [];
 for (let i = 0; i < 3; i++) ids.push((await f.create()).message_id);
 await f.settle(ids[0]!, 'cancel');
 let reply: unknown;
 const host = await computer(h, f, async input => {
  reply = (await h.messaging.sendVisible({ ...f.context(undefined, input.runId), draftStateRevision: input.draftStateRevision },
   { type: 'text', content: 'Would you like revisions to the remaining drafts?', end_turn: true })).acknowledgement;
 });
 const original = h.messaging.platformPrompt.bind(h.messaging);
 h.messaging.platformPrompt = async (...args: Parameters<typeof original>) => {
  const prompt = await original(...args);
  await Promise.all(ids.slice(1).map(id => f.settle(id, 'cancel')));
  return prompt;
 };
 await host.worker.execute(await f.claim());
 expect(host.failures).toEqual([]); expect(host.dispatched).toHaveLength(1);
 expect(reply).toMatchObject({ sent: false, reason: 'draft_state_changed', draft_state: { pending: 0 } });
 expect((await f.visible()).some(m => m.content.includes('Would you like revisions'))).toBe(false);
});

dbIt('cancellation fences draft publication: an in-flight publication commits first, a waiting reply is refused', async (h) => {
 const f = await fixture(h, verified, true);
 const ids: string[] = [];
 for (let i = 0; i < 2; i++) ids.push((await f.create()).message_id);
 await f.settle(ids[0]!, 'cancel');
 const turn = await f.claim();
 const context = f.context(undefined, turn.runId), snapshot = await h.messaging.draftReplySnapshot(context);
 const key = `draft-notification:${f.bot.id}:${context.channelId}`;
 // A publication holding the lock blocks the cancellation until it commits; others never see it half-written.
 const published = gate(), release = gate();
 let backend = 0;
 const publishing = h.db.$transaction(async tx => {
  backend = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  expect((await publishDraftNotification(tx, context))?.created).toBe(true);
  published.resolve(); await release.promise;
 }, { timeout: 15_000 });
 await published.promise;
 const cancellation = h.db.run.update({ where: { id: turn.runId }, data: { status: 'cancelled' } }).then(() => undefined); // Prisma queries are lazy.
 let blocked = false;
 for (const deadline = Date.now() + 20_000; !blocked && Date.now() < deadline; await Bun.sleep(10))
  blocked = (await h.db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${backend} = ANY(pg_blocking_pids(pid))) AS blocked`)[0]!.blocked;
 expect(blocked).toBe(true);
 expect(await f.visible()).toHaveLength(0);
 expect((await f.card(ids[0]!)).draftNotification.messageId).toBeUndefined();
 release.resolve(); await publishing; await cancellation;
 expect(await f.visible()).toHaveLength(1);
 expect((await h.messaging.flushDraftNotification(context))?.acknowledgement).toMatchObject({ sent: false, silent: true });

 // A reply already waiting on the draft lock when the turn is cancelled publishes nothing.
 for (const type of ['text', 'widget'] as const) {
  await h.db.run.update({ where: { id: turn.runId }, data: { status: 'running' } });
  const held = gate(), release = gate();
  const barrier = h.db.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`; held.resolve(); await release.promise; }, { timeout: 15_000 });
  await held.promise;
  const reply = h.messaging.sendVisible({ ...context, callId: crypto.randomUUID(), draftStateRevision: snapshot.revision }, type === 'text'
   ? { type, content: 'A late draft confirmation.' } : { type, widget: { prompt: 'Revise the remaining draft?', options: [{ label: 'Revise', value: 'revise' }] } });
  expect(await advisoryWaiter(h.db, key)).toBe(true);
  await h.db.run.update({ where: { id: turn.runId }, data: { status: 'cancelled' } });
  release.resolve(); await barrier;
  expect((await reply).acknowledgement).toMatchObject(type === 'text' ? { sent: false, silent: true } : { sent: false, retryable: false, reason: 'turn_not_active' });
 }
 expect(await f.visible()).toHaveLength(1);
 expect(await h.db.channelMessage.count({ where: { channelId: context.channelId, metadata: { path: ['type'], equals: 'widget' } } })).toBe(0);
}, 60_000);

dbIt('queued cancellation waits for a concurrent draft-outcome claim and then stops the running turn', async (h) => {
 const f = await fixture(h, verified, true);
 const id = (await f.create()).message_id;
 const runId = (await f.settle(id, 'cancel')).runId!;
 const inbox = await h.db.inboxEvent.findFirstOrThrow({ where: { runId } });
 const key = `bot-run-claim:${f.bot.id}`, entered = gate(), release = gate();
 let transportCalls = 0;
 const service = new RunService(h.db, async () => {
  transportCalls++; expect((await h.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('running');
  return Response.json({ cancelled: true });
 });
 // Hold exactly the row order a worker claim uses, after it has selected queued work.
 const claiming = h.db.$transaction(async tx => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  await tx.inboxEvent.update({ where: { id: inbox.id }, data: { status: 'processing' } }); entered.resolve(); await release.promise;
  await tx.run.update({ where: { id: runId }, data: { status: 'running' } });
 }, { timeout: 15_000 });
 await entered.promise;
 const cancellation = Effect.runPromise(service.cancel(runId));
 expect(await advisoryWaiter(h.db, key)).toBe(true);
 expect((await h.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('queued');
 release.resolve(); await claiming; await cancellation;
 expect(transportCalls).toBe(1);
 expect((await h.db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('cancelled');
}, 60_000);

dbIt('concurrent card actions settle each card once, and a failed verification reopens review', async (h) => {
 let sends = 0, verifyGate: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
 const f = await fixture(h, async (input) => {
  if (input.arguments.action === 'verify') {
   if (verifyGate) { verifyGate.entered.resolve(); await verifyGate.release.promise; throw new Error('Synthetic verification unavailable'); }
   return { identity: 'me@example.com' };
  }
  sends++; return { id: 'sent' };
 });
 let expected = 0;
 for (let i = 0; i < 4; i++) {
  const id = (await f.create()).message_id;
  await Promise.all((i % 2 ? ['send', 'cancel'] : ['cancel', 'send']).map(action => f.settle(id, action)));
  const { cardState, outcomeId } = await f.card(id);
  expect(['sent', 'dismissed']).toContain(cardState);
  expected += cardState === 'sent' ? 1 : 0;
  await Promise.all([f.settle(id, 'send'), f.settle(id, 'cancel'), f.settle(id, 'send')]);
  expect((await f.card(id)).outcomeId).toBe(outcomeId);
  expect(sends).toBe(expected);
 }
 // A discard while the send is verifying is ignored; the failed verification reopens review without a wake.
 const id = (await f.create()).message_id, wakes = await f.wakes();
 verifyGate = { entered: gate(), release: gate() };
 const sending = f.settle(id, 'send');
 await verifyGate.entered.promise;
 expect((await h.messaging.draftReplySnapshot(f.context())).counts).toMatchObject({ sending: 1 });
 await f.settle(id, 'cancel'); expect((await f.card(id)).cardState).toBe('sending');
 verifyGate.release.resolve(); await sending; verifyGate = null;
 expect(await f.card(id)).toMatchObject({ cardState: 'pending', sendError: 'Synthetic verification unavailable' });
 expect((await f.card(id)).outcomeId).toBeUndefined();
 expect(await f.wakes()).toBe(wakes); expect(sends).toBe(expected);
 await f.settle(id, 'cancel'); expect((await f.card(id)).cardState).toBe('dismissed');
});

dbIt('outcome state and its wake commit together; a confirmed send recovers without another transport call', async (h) => {
 let sends = 0;
 const plugins = new PluginInvocations(h.db, async (callId) => {
  const call = await h.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
  const result = (call.arguments as any).action === 'verify' ? { identity: 'me@example.com' } : { id: `synthetic-${++sends}` };
  await h.db.pluginInvocation.update({ where: { callId }, data: { status: 'completed', result, completedAt: new Date() } });
  return result;
 });
 const f = await fixture(h);
 const service = f.using(plugins);
 const enqueue = h.messaging.enqueueDraftOutcome.bind(h.messaging);
 const outage = () => { h.messaging.enqueueDraftOutcome = async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw new Error('injected outcome queue outage'); }; };
 try {
  // A discard rolls back with its wake, also when another outcome wake is already queued.
  for (const queued of [false, true]) {
   const id = (await f.create()).message_id;
   const updates = await h.db.event.count({ where: { topic: 'channel.message.updated', entityId: id } });
   outage();
   await expect(f.settle(id, 'cancel')).rejects.toThrow('injected outcome queue outage');
   h.messaging.enqueueDraftOutcome = enqueue;
   expect((await f.card(id)).cardState ?? 'pending').toBe('pending');
   expect((await f.card(id)).outcomeId).toBeUndefined();
   expect(await h.db.event.count({ where: { topic: 'channel.message.updated', entityId: id } })).toBe(updates);
   expect(await f.wakes()).toBe(queued ? 1 : 0);
   if (!queued) { await f.settle(id, 'cancel'); await f.settle(id, 'cancel'); expect(await f.wakes()).toBe(1); }
  }
  // A send the connector confirmed stays recorded through the rollback and settles on refresh, once.
  const card = (await f.create('confirmed', {}, service)).message_id;
  outage();
  await expect(f.settle(card, 'send', undefined, service)).rejects.toThrow('injected outcome queue outage');
  h.messaging.enqueueDraftOutcome = enqueue;
  expect(await f.card(card)).toMatchObject({ cardState: 'sending' });
  expect(await h.db.pluginInvocation.findUniqueOrThrow({ where: { callId: `draft-send:${card}:send` } })).toMatchObject({ status: 'completed', result: { id: 'synthetic-1' } });
  const restarted = f.using(plugins);
  await Promise.all(['refresh', 'send', 'refresh'].map(action => f.settle(card, action, undefined, restarted)));
  expect(await f.card(card)).toMatchObject({ cardState: 'sent', outcomeId: expect.any(String) });
  expect(sends).toBe(1);
  expect(await f.wakes()).toBe(2);
 } finally { h.messaging.enqueueDraftOutcome = enqueue; }
});

dbIt('a late result cannot reopen a timed-out card or repeat its transport', async (h) => {
 for (const late of ['verification-fails', 'verification-succeeds', 'transport-succeeds', 'transport-fails'] as const) {
  const entered = gate(), release = gate();
  let verifies = 0, sends = 0;
  const f = await fixture(h, async (input) => {
   if (input.arguments.action === 'verify') {
    if (++verifies > 1 && late.startsWith('verification')) { entered.resolve(); await release.promise; if (late === 'verification-fails') throw new Error('Late verification outage'); }
    return { identity: 'me@example.com' };
   }
   sends++;
   if (late.startsWith('transport')) { entered.resolve(); await release.promise; if (late === 'transport-fails') throw new Error('Synthetic late response loss'); }
   return { id: 'synthetic-late' };
  });
  const id = (await f.create()).message_id;
  const sending = settled(f.settle(id, 'send'));
  await entered.promise;
  await f.expire(id);
  await f.settle(id, 'refresh');
  const terminal = await f.card(id);
  expect(terminal.cardState).toBe('unknown');
  release.resolve(); await sending;
  for (const action of ['send', 'cancel', 'save', 'refresh']) await f.settle(id, action, action === 'save' ? { body: 'Must not replace terminal content' } : undefined);
  expect(await f.card(id)).toMatchObject({ cardState: 'unknown', outcomeId: terminal.outcomeId, draft: { body: f.draft.body } });
  expect((await f.card(id)).sendError).toBeUndefined();
  expect(sends).toBe(late.startsWith('transport') ? 1 : 0);
  expect(await f.wakes()).toBe(0);
 }
}, 60_000);

dbIt('recovery trusts only the card\'s own complete connector receipt', async (h) => {
 const f = await fixture(h), other = await fixture(h);
 // Valid envelopes confirm the reviewed recipients and content exactly once.
 for (const result of [{ content: [{ type: 'text', text: JSON.stringify({ id: 'synthetic-sent-id' }) }] },
  { accepted: ['reviewed@example.com', 'copied@example.com'], rejected: [], messageId: 'synthetic-message-id' }]) {
  const id = (await f.create()).message_id;
  await f.settle(id, 'save', { to: ['reviewed@example.com'], cc: ['copied@example.com'], subject: 'Reviewed subject', body: 'Reviewed body' });
  await f.interrupted(id, { status: 'completed', result });
  await Promise.all(['refresh', 'send', 'refresh', 'cancel'].map(action => f.settle(id, action)));
  expect(await f.card(id)).toMatchObject({ cardState: 'sent' });
  expect((await f.card(id)).outcomeText).toContain('To: reviewed@example.com\nCc: copied@example.com\nSubject: Reviewed subject\n\nReviewed body');
 }
 expect(await f.wakes()).toBe(2);
 // Unreadable, partial or borrowed receipts stay unconfirmed and wake no one.
 const borrowed = { botId: other.bot.id, runId: other.run.id, connectionId: other.connection.id };
 for (const receipt of [
  { status: 'completed', result: { content: [{ type: 'text', text: 'The response was lost after the remote operation.' }] } },
  { status: 'completed', result: { messageId: 'synthetic-partial', accepted: ['ann@example.com'], rejected: ['bob@example.com'] } },
  ...Object.entries(borrowed).map(([field, value]) => ({ status: 'completed', result: { id: 'unrelated-success' }, [field]: value })),
 ]) {
  const id = (await f.create(undefined, { to: ['ann@example.com', 'bob@example.com'] })).message_id;
  await f.interrupted(id, receipt);
  await f.settle(id, 'refresh');
  const recovered = await f.card(id);
  expect(recovered.cardState).toBe('unknown');
  expect(recovered.outcomeText).toContain('may or may not have gone out');
  await Promise.all(['send', 'cancel'].map(action => f.settle(id, action)));
  expect((await f.card(id)).outcomeId).toBe(recovered.outcomeId);
 }
 expect(await f.wakes()).toBe(2);
 // A fresh automatic send with an incomplete confirmation is not reported as sent.
 await h.db.bot.update({ where: { id: f.bot.id }, data: { draftingDisabled: true } });
 const automatic = await f.create(undefined, { to: ['ann@example.com', 'bob@example.com'] }, f.using(async input => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { messageId: 'partial', accepted: ['ann@example.com'], rejected: [] }));
 expect(automatic.delivery).toBe('unknown');
 expect(renderControlResult('DraftExternalMessage', automatic, f.draft)).toContain('Do not resend');
}, 60_000);

dbIt('a reviewed card keeps its original connection when the account is renamed or its namespace reused', async (h) => {
 const packets: any[] = [];
 const f = await fixture(h, async (input) => { if (input.arguments.action !== 'verify') packets.push(input); return input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: 'sent' }; });
 const name = `Unique fixture ${crypto.randomUUID()}`;
 await h.db.pluginConnection.update({ where: { id: f.connection.id }, data: { name } });
 const namespace = (await loadConnectionNamespaces(h.db)).get(f.connection.id)!;
 const body = 'Hi Ann,\n\nThe meeting is on Monday at ten.\n\nThanks!';
 const card = await f.create('baseline', { providerIdentifier: namespace, body });
 await h.db.pluginConnection.update({ where: { id: f.connection.id }, data: { alias: 'renamed-account' } });
 const replacement = await h.db.pluginConnection.create({ data: { installationId: f.connection.installationId, connectorKey: 'email', name, transport: 'stdio', authType: 'none', status: 'ready' } });
 expect((await loadConnectionNamespaces(h.db)).get(replacement.id)).toBe(namespace);
 await f.settle(card.message_id, 'send');
 expect((await f.card(card.message_id)).cardState).toBe('sent');
 expect(packets).toHaveLength(1); expect(packets[0].connectionId).toBe(f.connection.id);
 // A later revision of the same email still highlights what changed against the earlier card.
 await h.db.channelMessage.create({ data: { channelId: f.bot.channelId!, sender: 'user', content: 'Change Monday to Tuesday', clientId: crypto.randomUUID() } });
 const next = await h.run(f.bot);
 const updated = await f.service.create(f.context('revision', next.id), { ...f.draft, body: body.replace('Monday', 'Tuesday') }) as any;
 const revision = (await f.card(updated.message_id)).draft.verification.revision;
 expect(revision.baselineMessageId).toBe(card.message_id);
 expect(revision.body.filter((part: any) => part.added).map((part: any) => part.text).join('')).toContain('Tuesday');
});

dbIt('archive or deletion during verification creates no card and dispatches nothing', async (h) => {
 for (const removal of ['archive', 'delete-bot', 'delete-card'] as const) {
  const entered = gate(), release = gate();
  let verifies = 0, sends = 0;
  // Creating verifies once; sending verifies again. Hold the verification that matters.
  const holdAt = removal === 'delete-card' ? 2 : 1;
  const f = await fixture(h, async (input) => {
   if (input.arguments.action === 'verify') { if (++verifies === holdAt) { entered.resolve(); await release.promise; } return { identity: 'me@example.com' }; }
   sends++; return { id: 'never' };
  });
  const result = removal === 'delete-card' ? f.create().then(card => settled(f.settle(card.message_id, 'send')).then(() => card)) : settled(f.create());
  await entered.promise;
  const id = removal === 'delete-card' ? (await h.db.channelMessage.findFirstOrThrow({ where: { senderBotId: f.bot.id } })).id : undefined;
  if (removal === 'archive') await h.db.channel.update({ where: { id: f.bot.channelId! }, data: { archivedAt: new Date() } });
  else if (removal === 'delete-bot') await h.db.bot.delete({ where: { id: f.bot.id } });
  else await h.db.channelMessage.delete({ where: { id: id! } });
  release.resolve();
  const outcome = await result as any;
  if (removal !== 'delete-card') expect(outcome.error).toBeDefined();
  expect(await h.db.channelMessage.count({ where: { channelId: f.bot.channelId! } })).toBe(0);
  expect(sends).toBe(0);
  expect(await h.db.inboxEvent.count({ where: { botId: f.bot.id, type: 'draft.response' } })).toBe(0);
 }
});

/** Exercise the durable retirement phase only. No runtime cleanup or remote call. */
async function retire(db: Db, botId: string, channelId: string) {
 await db.$transaction(async tx => {
  await lockAgentLifecycle(tx, botId);
  await tx.run.updateMany({ where: { botId, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', completedAt: new Date() } });
  await tx.inboxEvent.updateMany({ where: { botId, status: { in: ['pending', 'processing'] } }, data: { status: 'completed', completedAt: new Date() } });
  await tx.bot.update({ where: { id: botId }, data: { status: 'archived' } });
  await tx.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
 });
}

dbIt('retirement while a send is in flight keeps its known outcome without waking the retired bot', async (h) => {
 for (const result of ['confirmed', 'uncertain', 'account-change', 'channel-only'] as const) {
  const entered = gate(), release = gate();
  let verifies = 0, sends = 0;
  const f = await fixture(h, async (input) => {
   if (input.arguments.action === 'verify') {
    if (result === 'account-change' && ++verifies > 1) { entered.resolve(); await release.promise; return { identity: 'other@example.com', sendingAddresses: ['me@example.com'] }; }
    return { identity: 'me@example.com' };
   }
   sends++; entered.resolve(); await release.promise;
   if (result === 'uncertain') throw new Error('Synthetic response loss after transport entry');
   return { id: 'synthetic-confirmed' };
  });
  const card = await f.create();
  const sending = settled(f.settle(card.message_id, 'send'));
  await entered.promise;
  if (result === 'channel-only') await h.db.channel.update({ where: { id: f.bot.channelId! }, data: { archivedAt: new Date() } });
  else await retire(h.db, f.bot.id, f.bot.channelId!);
  release.resolve();
  expect((await sending).error).toBeUndefined();
  expect(await f.card(card.message_id)).toMatchObject({ cardState: { confirmed: 'sent', 'channel-only': 'sent', uncertain: 'unknown', 'account-change': 'failed' }[result], outcomeId: expect.any(String), outcomeEchoed: false });
  expect(sends).toBe(result === 'account-change' ? 0 : 1);
  expect(await f.wakes()).toBe(0);
  expect(await h.db.run.count({ where: { botId: f.bot.id, status: { in: ['queued', 'running'] } } })).toBe(result === 'channel-only' ? 1 : 0);
 }
}, 60_000);

dbIt('a discard and a retirement serialize on the lifecycle lock in either order', async (h) => {
 const retirementDb = createPrismaClient(databaseUrl!);
 h.onClose(() => retirementDb.$disconnect());
 // Settlement first: retirement waits until the discard's wake is in its cancellation snapshot.
 {
  const f = await fixture(h), entered = gate(), release = gate();
  const card = await f.create();
  const transaction = h.db.$transaction.bind(h.db);
  let armed = true;
  // Pause after enqueueWake has read an active owner, before creating its Run.
  h.db.$transaction = ((work: any, options: any) => transaction(async (tx: any) => {
   const read = tx.bot.findUnique.bind(tx.bot);
   tx.bot.findUnique = async (args: any) => {
    const value = await read(args);
    if (armed && args.where?.id === f.bot.id && args.include?.conversation) { armed = false; entered.resolve(); await release.promise; }
    return value;
   };
   return work(tx);
  }, options)) as typeof h.db.$transaction;
  try {
   const cancelling = settled(f.settle(card.message_id, 'cancel'));
   await entered.promise;
    const retiring = retire(retirementDb, f.bot.id, f.bot.channelId!);
   expect(await advisoryWaiter(retirementDb, `agent-lifecycle:${f.bot.id}`)).toBe(true);
   release.resolve();
   expect((await cancelling).error).toBeUndefined(); await retiring;
  } finally { release.resolve(); h.db.$transaction = transaction as typeof h.db.$transaction; }
  expect(await f.card(card.message_id)).toMatchObject({ cardState: 'dismissed', outcomeId: expect.any(String) });
  expect(await h.db.run.count({ where: { botId: f.bot.id, status: { in: ['queued', 'running'] } } })).toBe(0);
  expect((await h.db.inboxEvent.findFirstOrThrow({ where: { botId: f.bot.id, type: 'draft.response' } })).status).toBe('completed');
 }
 // Retirement first: a discard already waiting on the lock is refused.
 {
  const f = await fixture(h), acquired = gate(), release = gate();
  const card = await f.create();
  const retiring = h.db.$transaction(async tx => {
   await lockAgentLifecycle(tx, f.bot.id); acquired.resolve(); await release.promise;
   await tx.bot.update({ where: { id: f.bot.id }, data: { status: 'archived' } });
   await tx.channel.update({ where: { id: f.bot.channelId! }, data: { archivedAt: new Date() } });
  });
  await acquired.promise;
  const cancelling = settled(f.settle(card.message_id, 'cancel'));
  expect(await advisoryWaiter(h.db, `agent-lifecycle:${f.bot.id}`)).toBe(true);
  release.resolve(); await retiring;
  expect(String((await cancelling).error)).toContain('Draft card not found');
  expect((await f.card(card.message_id)).outcomeId).toBeUndefined();
  expect(await f.wakes()).toBe(0);
 }
}, 60_000);

dbIt('reviewed sends during a busy foreground turn queue and continue in one later turn', async (h) => {
 let attempts = 0;
 const plugins = new PluginInvocations(h.db, async callId => {
  const call = await h.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
  const result = (call.arguments as any).action === 'verify' ? { identity: 'me@example.com' } : { id: `synthetic-distinct-${++attempts}`, labelIds: ['SENT'] };
  await h.db.pluginInvocation.update({ where: { callId }, data: { status: 'completed', result, completedAt: new Date() } }); return result;
 });
 const f = await fixture(h);
 const service = f.using(plugins);
 await h.db.botRunLease.create({ data: { botId: f.bot.id, runId: f.run.id, scope: 'foreground', ownerId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 120_000) } });
 const ids: string[] = [];
 for (let i = 0; i < 3; i++) ids.push((await f.create(`busy-${i}`, { to: [`provider${i}@example.com`], cc: ['copy@example.com'], body: `Reviewed content ${i}`, waitForReview: true }, service)).message_id);
 for (const id of ids) { await f.settle(id, 'send', undefined, service); expect(await f.claim()).toBeNull(); }
 await h.db.botRunLease.deleteMany({ where: { botId: f.bot.id } });
 await h.db.run.update({ where: { id: f.run.id }, data: { status: 'completed', completedAt: new Date() } });
 const claimed = await f.claim();
 for (const id of ids) expect(claimed.content).toContain(`Draft card ID: ${id}`);
 await h.messaging.flushDraftNotification(f.context(undefined, claimed.runId));
 await h.messaging.sendVisible(f.context('one-outcome-reply', claimed.runId), { type: 'text', content: (await f.visible())[0]!.content, end_turn: true });
 expect(await f.visible()).toHaveLength(1);
 await f.release(claimed); expect(await f.claim()).toBeNull();
 const records = await h.db.pluginInvocation.findMany({ where: { botId: f.bot.id, arguments: { path: ['action'], equals: 'send' } } });
 expect(new Set(records.map(row => (row.arguments as any).draft.to[0])).size).toBe(3);
 expect(attempts).toBe(3);
 for (const id of ids) expect(await f.card(id)).toMatchObject({ cardState: 'sent' });
});

dbIt('server restart resumes pending draft follow-up once per attempt and fences the interrupted turn', async (h) => {
 const f = await fixture(h);
 const restart = () => recover(h.db, { send: async () => crypto.randomUUID() } as never, h.messaging, async () => new Response());
 await h.db.run.update({ where: { id: f.run.id }, data: { status: 'completed' } });
 const ids = [(await f.create()).message_id, (await f.create()).message_id];
 await f.settle(ids[0]!, 'cancel'); await f.settle(ids[1]!, 'send');
 let current = await f.claim();
 const rootRunId = current.runId;
 const draftNotification = ((await h.db.inboxEvent.findUniqueOrThrow({ where: { id: current.inboxId } })).payload as any).draftNotification;
 const receipt = (await h.messaging.flushDraftNotification(f.context(undefined, current.runId)))?.acknowledgement as any;
 for (let attempt = 1; attempt <= 3; attempt++) {
  const interruptedRun = current.runId;
  await restart(); await restart();
  // An old computer must not add a late acknowledgement after the restart.
  expect((await h.messaging.sendVisible(f.context(undefined, interruptedRun), { type: 'text', content: 'Obsolete status confirmation' })).acknowledgement).toMatchObject({ sent: false });
  const pending = await h.db.inboxEvent.findMany({ where: { botId: f.bot.id, status: 'pending' } });
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ type: 'draft.response', idempotencyKey: `runtime-recovery:${rootRunId}:${attempt}` });
  expect((pending[0]!.payload as any).draftNotification).toEqual(draftNotification);
  current = await f.claim();
  // The resumed turn reuses the status already published rather than posting another.
  expect((await h.messaging.flushDraftNotification(f.context(undefined, current.runId)))?.acknowledgement).toMatchObject({ message_id: receipt.message_id });
 }
 await restart();
 expect(await f.wakes('pending')).toBe(0);
 expect(await f.visible()).toHaveLength(1);
 expect((await f.visible()).some(message => message.content === 'Obsolete status confirmation')).toBe(false);
 expect([(await f.card(ids[0]!)).cardState, (await f.card(ids[1]!)).cardState]).toEqual(['dismissed', 'sent']);
}, 60_000);

dbIt('server restart never replays a reviewed send and does not revive an archived chat', async (h) => {
 const restart = () => recover(h.db, { send: async () => crypto.randomUUID() } as never, h.messaging, async () => new Response());
 for (const confirmed of [false, true]) {
  let sends = 0;
  const f = await fixture(h, async input => input.arguments.action === 'verify' ? { identity: 'me@example.com' } : { id: `resent-${++sends}` });
  const id = (await f.create()).message_id;
  await f.interrupted(id, confirmed ? { status: 'completed', result: { id: 'already-sent-before-restart' }, completedAt: new Date() } : { error: 'Executing' }, new Date(Date.now() - 181_000));
  await restart();
  await Promise.all(['refresh', 'send', 'cancel'].map(action => f.settle(id, action)));
  expect(await f.card(id)).toMatchObject({ cardState: confirmed ? 'sent' : 'unknown', outcomeId: expect.any(String) });
  expect(sends).toBe(0);
  expect(await f.wakes()).toBe(confirmed ? 1 : 0);
 }
 const f = await fixture(h);
 await h.db.run.update({ where: { id: f.run.id }, data: { status: 'completed' } });
 await f.settle((await f.create()).message_id, 'cancel');
 await f.claim();
 await h.db.channel.update({ where: { id: f.bot.channelId! }, data: { archivedAt: new Date() } });
 await restart();
 expect(await f.wakes('pending')).toBe(0);
 expect(await f.claim()).toBeNull();
 expect(await f.visible()).toHaveLength(0);
});

dbIt('a status, its receipts and its push commit together; progress updates never rewrite a push already delivering', async (h) => {
 const f = await fixture(h, verified, true);
 const ids: string[] = [];
 for (let i = 0; i < 4; i++) ids.push((await f.create()).message_id);
 await f.settle(ids[0]!, 'cancel');
 const claimed = await f.claim();
 // Register the device after the cards exist, so only statuses queue pushes.
 const where = await pushDevice(h, f);
 const context = f.context(undefined, claimed.runId);
 const notifications = () => h.db.channelNotification.count({ where: { channelId: f.bot.channelId! } });
 const before = await notifications();
 await expect(h.db.$transaction(async tx => {
  expect((await publishDraftNotification(tx, context))?.created).toBe(true);
  expect(await tx.outboxDelivery.count({ where })).toBe(1);
  throw new Error('injected crash before commit');
 })).rejects.toThrow('injected crash before commit');
 expect(await f.visible()).toHaveLength(0);
 expect((await f.card(ids[0]!)).draftNotification.messageId).toBeUndefined();
 expect(await notifications()).toBe(before);
 expect(await h.db.outboxDelivery.count({ where })).toBe(0);
 expect(await h.messaging.flushDraftNotification({ ...context, channelId: crypto.randomUUID() })).toBeNull();
 await Promise.all(Array.from({ length: 3 }, () => h.messaging.flushDraftNotification(context)));
 expect(await f.visible()).toHaveLength(1);
 expect(await notifications()).toBe(before + 1);
 const progress = (await f.visible())[0]!;
 const outbox = await h.db.outboxDelivery.findFirstOrThrow({ where });
 await f.release(claimed);

 // A crashed update keeps the old row and push body; a committed one rewrites both in place.
 await f.settle(ids[1]!, 'cancel'); await f.recent();
 const second = await f.claim();
 await expect(h.db.$transaction(async tx => {
  expect((await publishDraftNotification(tx, f.context(undefined, second.runId)))?.updated).toBe(true);
  throw new Error('crash while updating progress');
 })).rejects.toThrow('crash while updating progress');
 expect((await f.visible())[0]!.content).toBe(progress.content);
 expect((await f.card(ids[1]!)).draftNotification.messageId).toBeUndefined();
 await h.messaging.flushDraftNotification(f.context(undefined, second.runId));
 const updated = (await f.visible())[0]!;
 expect(updated.id).toBe(progress.id);
 expect(updated.content).toContain('2 discarded without sending');
 expect(((await h.db.outboxDelivery.findUniqueOrThrow({ where: { id: outbox.id } })).payload as any).body).toBe(updated.content);
 expect(((await h.db.channelNotification.findUniqueOrThrow({ where: { key: `message:${progress.id}` } })).payload as any).body).toBe(updated.content);
 await f.release(second);
 // Once the push is delivering or delivered, later progress leaves it alone and queues no other.
 for (const [index, status] of (['delivering', 'delivered'] as const).entries()) {
  await h.db.outboxDelivery.update({ where: { id: outbox.id }, data: { status } });
  await f.settle(ids[index + 2]!, 'cancel'); await f.recent();
  const turn = await f.claim();
  await h.messaging.flushDraftNotification(f.context(undefined, turn.runId)); await f.release(turn);
  const stored = await h.db.outboxDelivery.findUniqueOrThrow({ where: { id: outbox.id } });
  expect(stored.status).toBe(status); expect((stored.payload as any).body).toBe(updated.content);
  expect(await h.db.outboxDelivery.count({ where })).toBe(1);
  expect((await f.visible()).map(message => message.id)).toEqual([progress.id]);
 }
 expect((await f.visible())[0]!.content).toContain('none awaiting review');
 expect(await notifications()).toBe(before + 1);
});
