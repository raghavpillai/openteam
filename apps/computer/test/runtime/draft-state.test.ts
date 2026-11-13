import { expect, test } from 'bun:test';
import { RuntimeTools } from '../../src/runtime/tools';
import { routeEvent } from '../../src/runtime/events';
import type { ActiveTurn } from '../../src/runtime/types';

test('draft snapshot refresh waits until the next model response and preserves a retried warning', async () => {
 const calls: any[] = [];
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const input = await request.json() as any; calls.push(input);
  if (input.draftStateRevision === 'old') return Response.json({ sent: false, delivery_failed: true, retryable: true,
   reason: 'draft_state_changed', draft_state_revision: 'fresh', draft_state: { pending: 0 }, cards: [],
   note: 'Nothing was delivered. Reconsider the question; retry useful warnings in the next response.' });
  return Response.json({ sent: true, message_id: 'warning-receipt' });
 } });
 const active = { runId: 'run', botId: 'bot', conversationId: 'conversation', channelId: 'channel', deliveryId: null,
  screenBotId: 'screen', requestSource: 'event', runtimeProfile: 'agent', subagentType: null,
  draftStateRevision: 'old', sentMessageCount: 0, userAcknowledged: false, assistantOrdinal: 1,
  failedResponseSends: new Set(), queue: { push() {} },
 } as unknown as ActiveTurn;
 const tools = new RuntimeTools({} as never, server.url.origin, 'fixture', '/tmp', '/tmp') as any;
 try {
  const send = (id: string, content: string, end_turn = false) => tools.executeOpenTeamTool(active, id, 'SendToUser', { type: 'text', content, end_turn });
  const rejected = await send('old-question', 'Would you like revisions?', true);
  expect(rejected.details?.isError).toBe(true);
  expect(rejected.content[0]).toMatchObject({ text: expect.stringContaining('"pending":0') });
  expect(active.endTurnRequested).toBeUndefined(); expect(active.sentMessageCount).toBe(0);
  expect(active.draftStateRevision).toBe('old'); expect(active.pendingDraftStateRevision).toBe('fresh');
  const sibling = await send('old-warning', 'Disk check failed.');
  expect(sibling.details?.isError).toBe(true); expect(calls[1].draftStateRevision).toBe('old');
  routeEvent(undefined, active, { type: 'message_start', message: { role: 'assistant' } } as any);
  expect(active.draftStateRevision).toBe('fresh'); expect(active.pendingDraftStateRevision).toBeUndefined();
  const delivered = await send('fresh-warning', 'Disk check failed.');
  expect(delivered.details?.isError).toBeUndefined(); expect(calls[2].draftStateRevision).toBe('fresh');
  expect(active.sentMessageCount).toBe(1);
 } finally { server.stop(true); }
});

test('ordinary turns send no private draft snapshot', async () => {
 let captured: any;
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { captured = await request.json(); return Response.json({ sent: true }); } });
 const tools = new RuntimeTools({} as never, server.url.origin, 'fixture', '/tmp', '/tmp') as any;
 const active = { runId: 'run', botId: 'bot', screenBotId: 'screen', sentMessageCount: 0, queue: { push() {} } } as unknown as ActiveTurn;
 try {
  await tools.executeOpenTeamTool(active, 'ordinary', 'SendToUser', { type: 'text', content: 'An ordinary answer.' });
  expect(captured.draftStateRevision).toBeUndefined(); expect(active.sentMessageCount).toBe(1);
 } finally { server.stop(true); }
});
