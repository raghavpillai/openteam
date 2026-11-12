import { expect, test } from 'bun:test';
import { draftResponseBatch } from '../src/worker';

const wake = (id: string, channelId = 'chat') => ({ id, type: 'draft.response', status: 'pending', createdAt: new Date(), payload: {}, run: { origin: 'user' as const, channelId } });
test('24 ready draft outcomes produce one continuation with 23 folded receipts', () => {
 const outcomes = Array.from({ length: 24 }, (_, i) => ({ ...wake(String(i)),
  payload: { content: `[SAND_HIDDEN_PROMPT]Draft card ID: card-${i}\nState: ${i % 2 ? 'dismissed' : 'sent'}\nSubject: Same subject` } }));
 const batch = draftResponseBatch(outcomes[0]!, outcomes)!;
 expect(batch.folded).toHaveLength(23);
 expect(batch.content).toContain('24 external message draft outcome(s)');
 expect(batch.content).toContain('continue once');
 for (let i = 0; i < 24; i++) expect(batch.content).toContain(`Draft card ID: card-${i}\n`);
 expect(batch.content.match(/\[SAND_HIDDEN_PROMPT\]/g)).toHaveLength(1);
 expect(batch.content.match(/State: sent/g)).toHaveLength(12);
 expect(batch.content.match(/State: dismissed/g)).toHaveLength(12);
 expect(batch.content).toContain('Do not infer other cards are still open');
});
test('draft batching preserves other chats, real user requests, and processing events', () => {
 const first = wake('first');
 const batch = draftResponseBatch(first, [first, wake('second'), wake('other-chat', 'elsewhere'),
  { ...wake('user'), type: 'user.message' }, { ...wake('processing'), status: 'processing' }])!;
 expect(batch.folded.map(item => item.id)).toEqual(['second']);
 expect(draftResponseBatch({ ...first, status: 'processing' }, [wake('second')])).toBeNull();
 expect(draftResponseBatch({ ...first, type: 'user.message' }, [wake('second')])).toBeNull();
 expect(draftResponseBatch(first, [first])?.folded).toEqual([]);
});
