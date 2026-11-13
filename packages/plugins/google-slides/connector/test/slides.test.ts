import { expect, test } from 'bun:test';
import { ToolContent } from '../../../_shared/google';
import { harness } from '../../../test/parity-harness';
import { slidesTools } from '../server';

const pageSize = { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } };
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

test('get_slide_thumbnail returns the PNG and its size without sending the token to the content URL', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const thumb = { width: 1600, height: 900, contentUrl: 'https://lh7-rt.googleusercontent.com/slides/abc' };
  const make = (responses: any[]) => { const h = harness(api => slidesTools(api, (url, init) => (api as any).fetcher(url, init)), responses); return h; };
  const h = make([thumb, new Response(png, { headers: { 'content-type': 'image/png' } })]);
  const result = await h.call('get_slide_thumbnail', { ...base, size: 'LARGE' });
  expect(h.requests[0]!.url.pathname).toBe('/v1/presentations/deck/pages/p1/thumbnail');
  expect(Object.fromEntries(h.requests[0]!.url.searchParams)).toEqual({ 'thumbnailProperties.thumbnailSize': 'LARGE', 'thumbnailProperties.mimeType': 'PNG' });
  expect(h.requests[1]!.url.href).toBe(thumb.contentUrl);
  expect(JSON.stringify(h.requests[1]!.init.headers ?? {})).not.toContain('fixture-token');
  expect(result).toBeInstanceOf(ToolContent);
  expect(result.content).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ pageObjectId: 'p1', width: 1600, height: 900 }) }]);
  const d = make([{ ...thumb, width: 800 }, new Response(png)]);
  await d.call('get_slide_thumbnail', base);
  expect(d.requests[0]!.url.searchParams.get('thumbnailProperties.thumbnailSize')).toBe('MEDIUM');
  await expect(make([{ ...thumb, contentUrl: 'https://evil.example/x.png' }]).call('get_slide_thumbnail', base)).rejects.toThrow('unexpected thumbnail URL');
  await expect(make([{ ...thumb, contentUrl: 'http://lh3.googleusercontent.com/x' }]).call('get_slide_thumbnail', base)).rejects.toThrow('unexpected thumbnail URL');
  await expect(make([thumb, new Response(new Uint8Array(26 * 1024 * 1024))]).call('get_slide_thumbnail', base)).rejects.toThrow('Thumbnail exceeds');
  const flaky = make([thumb, new Response('', { status: 502 }), new Response(png, { headers: { 'content-type': 'image/png' } })]);
  expect((await flaky.call('get_slide_thumbnail', base)).content[0].data).toBe(png.toString('base64'));
  expect(flaky.requests.slice(1).map(r => r.url.href)).toEqual([thumb.contentUrl, thumb.contentUrl]);
  await expect(make([thumb, ...[1, 2, 3].map(() => new Response('', { status: 502 }))]).call('get_slide_thumbnail', base)).rejects.toThrow('HTTP 502');
});
