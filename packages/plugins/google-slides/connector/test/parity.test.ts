import { expect, test } from 'bun:test';
import { referenceTools } from '../../../_shared/reference';
import { ToolContent } from '../../../_shared/google';
import { createToolValidator } from '@openteam/plugin-sdk/json-schema';
import { slidesTools } from '../server';
import { harness } from '../../../test/parity-harness';
import { size, text } from './fixtures';

const base = { presentationId: 'deck', pageObjectId: 'p1' };

test('Slides implements exactly the pinned tools with unchanged schemas and matching risk', () => {
  const tools = slidesTools();
  expect(tools.map(t => t.name).sort()).toEqual(referenceTools.slides.map(t => t.name).sort());
  for (const reference of referenceTools.slides) {
    const tool = tools.find(t => t.name === reference.name)!;
    expect(tool.description).toBe(reference.description);
    expect(tool.inputSchema).toEqual({ ...reference.inputSchema, required: reference.inputSchema.required ?? [], additionalProperties: false } as any);
    expect(tool.annotations.readOnlyHint).toBe(reference.annotations.readOnlyHint);
    expect(tool.annotations.destructiveHint).toBe(reference.name === 'delete_object');
    expect(createToolValidator(tool.inputSchema)({ unexpected: 'field' }).valid).toBe(false);
  }
  const compose = createToolValidator(tools.find(t => t.name === 'compose_slide')!.inputSchema);
  expect(compose({ presentationId: 'd', pageObjectId: 'p', root: { kind: 'stack', direction: 'row', children: [{ kind: 'grid', columns: 2, children: [{ kind: 'card', children: [{ kind: 'text', text: 'x', role: 'kpi' }] }, { kind: 'image', url: 'https://e.com/a.png', size: { flex: 2 } }] }] } }).valid).toBe(true);
  expect(compose({ presentationId: 'd', pageObjectId: 'p', root: { kind: 'card', children: [{ kind: 'image', url: 'https://e.com/a.png' }] } }).valid).toBe(false);
});

const layouts = { revisionId: 'r5', slides: [{ objectId: 'a' }, { objectId: 'b' }], layouts: [
  { objectId: 'L-tb', layoutProperties: { name: 'TITLE_AND_BODY' }, pageElements: [{ objectId: 'L-tb-title', shape: { placeholder: { type: 'TITLE' } } }, { objectId: 'L-tb-body', shape: { placeholder: { type: 'BODY' } } }] },
  { objectId: 'L-blank', layoutProperties: { name: 'BLANK' }, pageElements: [] },
  { objectId: 'L-title', layoutProperties: { name: 'TITLE' }, pageElements: [{ objectId: 'L-t-ct', shape: { placeholder: { type: 'CENTERED_TITLE' } } }, { objectId: 'L-t-sub', shape: { placeholder: { type: 'SUBTITLE' } } }] },
] };

test('A stale requiredRevisionId fails with an actionable message', async () => {
  const h = harness(slidesTools, [new Response(JSON.stringify({ error: { message: 'The required revision ID does not match the latest revision.' } }), { status: 400 })]);
  await expect(h.call('delete_object', { presentationId: 'deck', objectId: 'x', requiredRevisionId: 'old' })).rejects.toThrow('changed since revision old, so nothing was applied');
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
