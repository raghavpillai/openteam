import { expect, test } from 'bun:test';
import { slidesTools } from '../server';
import { contrast } from '../contrast';
import { harness } from '../../../test/parity-harness';
import { color, pageSize, size, text } from './fixtures';

const base = { presentationId: 'deck', pageObjectId: 'p1' };
const deck = { revisionId: 'r1', pageSize, slides: [{ objectId: 'p1', pageElements: [{ objectId: 'old-title' }, { objectId: 'old-body' }] }] };
const kpiTree = { kind: 'stack', direction: 'column', children: [
  { kind: 'text', text: 'Q3 results', role: 'h1' },
  { kind: 'stack', direction: 'row', size: 150, gap: 24, children: ['Revenue:$4.2M', 'Customers:1,240', 'NPS:62'].map(pair => ({ kind: 'card', children: [{ kind: 'text', text: pair.split(':')[0], role: 'caption', color: 'textSecondary' }, { kind: 'text', text: pair.split(':')[1], role: 'kpi' }] })) },
] };

test('compose_slide refuses failing contrast pairs and bad input before writing anything', async () => {
  const h = harness(slidesTools, [deck, deck, deck]);
  await expect(h.call('compose_slide', { ...base, theme: { palette: { surface: '#FFFFFF', textSecondary: '#DDDDDD' } }, root: { kind: 'card', children: [{ kind: 'text', text: 'Revenue', color: 'textSecondary' }] } })).rejects.toThrow('text "Revenue" in textSecondary #DDDDDD on surface #FFFFFF is 1.35:1, needs 4.5:1 (use #767676');
  await expect(h.call('compose_slide', { ...base, root: { kind: 'stack', direction: 'column', children: [{ kind: 'text', text: 'Body', color: '#123456' }] } })).rejects.toThrow('Refused before writing');
  await expect(h.call('compose_slide', { ...base, root: { kind: 'stack', direction: 'row', children: [{ kind: 'spacer', size: 700 }, { kind: 'image', url: 'https://e.com/i.png' }] } })).rejects.toThrow('No room for the image');
  await expect(h.call('compose_slide', { ...base })).rejects.toThrow('exactly one of root');
  await expect(h.call('compose_slide', { ...base, root: kpiTree, html: '<section></section>' })).rejects.toThrow('exactly one of root');
  await expect(harness(slidesTools, [{ ...deck, slides: [] }]).call('compose_slide', { ...base, root: kpiTree })).rejects.toThrow('Slide p1 is not in this presentation');
  expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(0);
});

