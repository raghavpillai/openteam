import { expect, test } from 'bun:test';
import { harness } from '../../../test/parity-harness';
import { docsTools } from '../server';

const run = (start: number, content: string, textStyle: any = {}) => ({ startIndex: start, endIndex: start + content.length, textRun: { content, textStyle } });
const para = (start: number, content: string, extra: any = {}) => ({ startIndex: start, endIndex: start + content.length, paragraph: { elements: [run(start, content)], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, ...extra } });
const sectionBreak = { endIndex: 1, sectionBreak: { sectionStyle: {} } };
const table = (start: number, rows: string[][]) => {
  let i = start + 1;
  const tableRows = rows.map(r => {
    const rowStart = i++;
    const tableCells = r.map(t => { const cellStart = i++; const p = para(i, `${t}\n`); i = p.endIndex; return { startIndex: cellStart, endIndex: i, content: [p], tableCellStyle: { rowSpan: 1, columnSpan: 1 } }; });
    return { startIndex: rowStart, endIndex: i, tableCells };
  });
  return { startIndex: start, endIndex: i + 1, table: { rows: rows.length, columns: rows[0]!.length, tableRows } };
};
const doc = (content: any[], documentTab: any = {}, tabs: any[] = []) => ({ documentId: 'doc', title: 'Plan', revisionId: 'rev-1',
  tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1', index: 0 }, documentTab: { body: { content }, ...documentTab } }, ...tabs] });
const written = { documentId: 'doc', replies: [{}], writeControl: { requiredRevisionId: 'rev-2' } };

const sample = () => doc([
  sectionBreak,
  para(1, 'Plan\n', { paragraphStyle: { namedStyleType: 'TITLE', alignment: 'CENTER' } }),
  { startIndex: 6, endIndex: 18, paragraph: { elements: [run(6, 'Hello '), run(12, 'world', { bold: true, link: { url: 'https://example.com' }, foregroundColor: { color: { rgbColor: { red: 1 } } } }), run(17, '\n')], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
  para(18, 'Milk\n', { bullet: { listId: 'kix.1' } }),
  para(23, 'Step\n', { bullet: { listId: 'kix.2', nestingLevel: 1 } }),
  table(28, [['A', 'B']]),
  para(37, 'End 😀\n'),
], {
  lists: { 'kix.1': { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } }, 'kix.2': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'ALPHA' }] } } },
  headers: { 'h.1': { headerId: 'h.1', content: [para(0, 'Confidential\n')] } }, documentStyle: { defaultHeaderId: 'h.1' },
}, [{ tabProperties: { tabId: 't.1', title: 'Notes', index: 1 }, documentTab: { body: { content: [sectionBreak, para(1, 'Second tab\n')] } },
  childTabs: [{ tabProperties: { tabId: 't.2', title: 'Child', parentTabId: 't.1', nestingLevel: 1 }, documentTab: { body: { content: [sectionBreak, para(1, '\n')] } } }] }]);

test('find_text returns fresh UTF-16 ranges in paragraphs and cells, never across cells', async () => {
  const h = harness(docsTools, Array.from({ length: 5 }, sample));
  const world = await h.call('find_text', { documentId: 'doc', text: 'world' });
  expect(world).toEqual({ documentId: 'doc', revisionId: 'rev-1', tabId: 't.0', totalMatches: 1, matches: [{ start: 12, end: 17, paragraph_start: 6, paragraph_end: 18, paragraph_text: 'Hello world' }] });
  expect((await h.call('find_text', { documentId: 'doc', text: '😀' })).matches[0]).toMatchObject({ start: 41, end: 43, paragraph_start: 37 });
  expect((await h.call('find_text', { documentId: 'doc', text: 'B' })).matches[0]).toMatchObject({ start: 34, end: 35, paragraph_text: 'B' });
  expect((await h.call('find_text', { documentId: 'doc', text: 'A\nB' })).matches).toEqual([]);
  expect((await h.call('find_text', { documentId: 'doc', text: 'o', occurrence: 2 })).matches).toEqual([{ start: 13, end: 14, paragraph_start: 6, paragraph_end: 18, paragraph_text: 'Hello world' }]);
  const many = harness(docsTools, [doc([sectionBreak, ...Array.from({ length: 25 }, (_, i) => para(1 + i * 2, 'x\n'))])]);
  const capped = await many.call('find_text', { documentId: 'doc', text: 'x' });
  expect(capped.matches).toHaveLength(20);
  expect(capped).toMatchObject({ totalMatches: 25, truncated: true });
});

test('delete_content rejects surrogate splits, table structure and final newlines before writing', async () => {
  // 'Hi 😀 there' puts the emoji's two code units at 4 and 5.
  const body = () => doc([sectionBreak, para(1, 'Hi 😀 there\n'), para(13, 'Before\n'), table(20, [['A', 'B']]), para(29, 'Tail\n')]);
  const h = harness(docsTools, Array.from({ length: 8 }, body));
  const rejects = async (startIndex: number, endIndex: number, message: string) => expect(h.call('delete_content', { documentId: 'doc', startIndex, endIndex })).rejects.toThrow(message);
  await rejects(5, 8, 'splits a surrogate pair');
  await rejects(24, 27, 'splits the table at 20');
  await rejects(29, 34, 'final newline of the tab body');
  await rejects(15, 20, 'newline before the table at 20');
  await rejects(23, 25, 'final newline of the table cell');
  await expect(h.call('delete_content', { documentId: 'doc', startIndex: 5, endIndex: 5 })).rejects.toThrow('greater than startIndex');
  expect(h.requests).toHaveLength(5);
  const ok = harness(docsTools, [body(), written, body(), written, body(), written]);
  await ok.call('delete_content', { documentId: 'doc', startIndex: 23, endIndex: 24 });
  expect(ok.requests[1]!.json).toEqual({ requests: [{ deleteContentRange: { range: { startIndex: 23, endIndex: 24, tabId: 't.0' } } }], writeControl: { requiredRevisionId: 'rev-1' } });
  await ok.call('delete_content', { documentId: 'doc', startIndex: 13, endIndex: 29, requiredRevisionId: 'mine' });
  expect(ok.requests[3]!.json.writeControl).toEqual({ requiredRevisionId: 'mine' });
  await ok.call('delete_content', { documentId: 'doc', startIndex: 4, endIndex: 6 });
  expect(ok.requests[5]!.json.requests[0].deleteContentRange.range).toEqual({ startIndex: 4, endIndex: 6, tabId: 't.0' });
});
