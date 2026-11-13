import { expect, test } from 'bun:test';
import { harness } from '../../../test/parity-harness';
import { normalizeCells, parseCells } from '../a1';
import { sheetsTools } from '../server';
import { renderSections } from '../values';

test('A1 cells parse to zero-based, end-exclusive bounds and normalize', () => {
  expect(parseCells('B2')).toEqual({ startRow: 1, endRow: 2, startCol: 1, endCol: 2 });
  expect(parseCells(' $a$1:$d$10 ')).toEqual({ startRow: 0, endRow: 10, startCol: 0, endCol: 4 });
  expect(parseCells('A:C')).toEqual({ startCol: 0, endCol: 3 });
  expect(parseCells('2:5')).toEqual({ startRow: 1, endRow: 5 });
  expect(parseCells('A5:A')).toEqual({ startRow: 4, startCol: 0, endCol: 1 });
  const cases: Record<string, string> = { 'b2': 'B2', 'A1:A1': 'A1', 'D10:A1': 'A1:D10', 'C:A': 'A:C', '5:1': '1:5', 'A5:A': 'A5:A', 'B2:D': 'B2:D', 'A1:C': 'A:C', 'ZZZ1': 'ZZZ1' };
  for (const [input, output] of Object.entries(cases)) expect(normalizeCells(input)).toBe(output);
  for (const bad of ['', 'A', '5', 'A:5', 'A:C10', 'A1:B2:C3', 'AAAA1', 'A0', 'A1-B2']) expect(() => parseCells(bad)).toThrow('Invalid cells');
  expect(() => parseCells('Sheet1!A1:B2')).toThrow('includes a tab');
});

test('Read sections share one budget, cut on whole rows and point nextCells at the first unread row', () => {
  const rows = [['h1', 'h2'], ['aaaa', 'bbbb'], ['cccc', 'dddd'], ['eeee', 'ffff']];
  const all = renderSections([{ range: 'Data!A1:B4', values: rows }], 1000);
  expect(all).toEqual({ truncated: false, sections: [{ sheet: 'Data', range: 'A1:B4', csv: 'h1,h2\naaaa,bbbb\ncccc,dddd\neeee,ffff' }] });
  const cut = renderSections([{ range: 'Data!A1:B4', values: rows }, { range: "'Other tab'!C5:C1000", values: [['x']] }], 'h1,h2\naaaa,bbbb'.length + 3);
  expect(cut.truncated).toBe(true);
  expect(cut.sections[0]).toEqual({ sheet: 'Data', range: 'A1:B4', csv: 'h1,h2\naaaa,bbbb', truncated: true, nextCells: 'A3:B4' });
  expect(cut.sections[1]).toEqual({ sheet: 'Other tab', range: 'C5:C1000', csv: '', truncated: true, nextCells: 'C5:C1000' });
  const empty = renderSections([{ range: 'Data!A1:B4', values: rows }, { range: 'Blank!A1:Z1000' }], 'h1,h2\naaaa,bbbb'.length);
  expect(empty.sections[1]).toEqual({ sheet: 'Blank', range: 'A1:Z1000', csv: '' });
});

const sheets = (responses: any[] = []) => harness(api => sheetsTools(api.at('https://sheets.googleapis.com')), responses);
const id = 'sheet123';

test('write_range leaves null cells untouched and clears "" cells', async () => {
  const h = sheets([{ spreadsheetId: id, totalUpdatedCells: 6, responses: [{ updatedRange: 'Data!A1:C3', updatedCells: 5 }, { updatedRange: 'Data!C2', updatedCells: 1 }] }]);
  const value = await h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1', values: [['a', 'b', 'c'], ['d', null, ''], ['g', null, null]] });
  expect(h.requests[0]!.json.data).toEqual([
    { range: "'Data'!A1:C3", majorDimension: 'ROWS', values: [['a', 'b', 'c'], ['d'], ['g']] },
    { range: "'Data'!C2", majorDimension: 'ROWS', values: [['']] },
  ]);
  expect(value).toEqual({ spreadsheetId: id, updatedRange: 'Data!A1:C3', updatedCells: 6, updatedRanges: ['Data!A1:C3', 'Data!C2'] });
  const none = sheets();
  expect(await none.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1', values: [[null]] })).toEqual({ spreadsheetId: id, updatedRange: null, updatedCells: 0 });
  expect(none.requests).toHaveLength(0);
});

test('write_range validates the cell limit, the target range and unaddressable titles before writing', async () => {
  const h = sheets();
  const big = Array.from({ length: 101 }, () => Array(100).fill('x'));
  await expect(h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1', values: big })).rejects.toThrow('at most 10000 cells');
  await expect(h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1:B2', values: [[1, 2, 3]] })).rejects.toThrow('does not fit cells A1:B2');
  await expect(h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A:B', values: [[1, 2, 3]] })).rejects.toThrow('does not fit');
  await expect(h.call('write_range', { spreadsheetId: id, sheet: 'Q1/Q2', cells: 'A1', values: [[1]] })).rejects.toThrow('rename_sheet_tab');
  await expect(h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'Data!A1', values: [[1]] })).rejects.toThrow('without the tab');
  expect(h.requests).toHaveLength(0);
});
