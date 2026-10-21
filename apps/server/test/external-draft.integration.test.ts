import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { ExternalDraftService } from '../src/services/external-draft-service';
import { loadConnectionNamespaces } from '../src/services/plugin/namespaces';
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

/** A Bot chat plus a connector account that declares reviewed sending. */
async function fixture(name: string) {
 const prisma = createPrismaClient(databaseUrl!); const root = await mkdtemp(join(tmpdir(), `${name}-`));
 const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID(), runId = crypto.randomUUID();
 const pluginKey = `mail-${crypto.randomUUID().slice(0, 8)}`;
 const data = new AgentDataStore(prisma, { root: join(root, 'data'), workspaceRoot: root });
 const messaging = new AgentMessaging(prisma, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never, data);
 const installation = await prisma.pluginInstallation.create({ data: { pluginKey, version: '1.0.0', name: 'Mail', publisher: 'Test', manifest: { key: pluginKey, name: 'Mail', skills: [], connections: [{ key: 'email', transport: 'stdio', drafts: { platform: 'email', tool: 'send_reviewed_email' } }] } } });
 const connection = await prisma.pluginConnection.create({ data: { installationId: installation.id, connectorKey: 'email', name: 'Mail', transport: 'stdio', authType: 'none', status: 'ready' } });
 await prisma.bot.create({ data: { id: botId, name: `${name} fixture`, defaultDirectory: root, status: 'active', onboardingStatus: 'completed', conversation: { create: { id: conversationId } } } });
 await prisma.channel.create({ data: { id: channelId, kind: 'bot_dm', directKey: `bot:${botId}`, name: `${name} fixture`, members: { create: { botId, ordinal: 0 } } } });
 const user = await prisma.message.create({ data: { botId, conversationId, role: 'user', content: 'Draft an email', clientId: 'fixture', status: 'completed' } });
 await prisma.run.create({ data: { id: runId, botId, conversationId, channelId, userMessageId: user.id, status: 'running', origin: 'user' } });
 await data.initializeBot(botId); await data.writeRootSettings({});
 const context = (callId: string) => ({ runId, botId, conversationId, channelId, deliveryId: null, origin: 'user' as const, callId, isFork: false, replyToMessageId: null });
 const card = async (id: string) => (await prisma.channelMessage.findUniqueOrThrow({ where: { id } })).metadata as any;
 const cleanup = async () => { await prisma.bot.deleteMany({ where: { id: botId } }); await prisma.channel.deleteMany({ where: { id: channelId } }); await prisma.pluginInstallation.deleteMany({ where: { pluginKey } }); await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); };
 return { prisma, messaging, botId, connection, context, card, cleanup };
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

  const interrupted = await service.create(f.context('reply-c'), draft) as { message_id: string };
  failSend = 'after';
  expect((await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'unknown' });
  const before = calls.length;
  await Effect.runPromise(service.mutate(interrupted.message_id, { action: 'send' }));
  expect(calls).toHaveLength(before);
  failSend = null;

  const stale = await service.create(f.context('reply-d'), draft) as { message_id: string };
  identity = 'someone-else@example.com';
  expect((await Effect.runPromise(service.mutate(stale.message_id, { action: 'send' }))).message.metadata).toMatchObject({ cardState: 'failed' });
  await expect(service.create(f.context('reply-e'), { ...draft, from: 'nobody@example.com' })).rejects.toThrow('does not match the draft From address');
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
