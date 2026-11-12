import { expect, test } from 'bun:test';
import { referenceTools } from '../../../_shared/reference';
import { harness } from '../../../test/parity-harness';
import { sheetsTools } from '../server';

const sheets = (responses: any[] = []) => harness(api => sheetsTools(api.at('https://sheets.googleapis.com')), responses);
const id = 'sheet123';
const batchReply = (reply: any = {}) => ({ spreadsheetId: id, replies: [reply] });
/** Run one batchUpdate tool and return its single request object. */
async function request(name: string, args: Record<string, any>) {
  const h = sheets([batchReply()]);
  const result = await h.call(name, { spreadsheetId: id, ...args });
  expect(result).toEqual(batchReply());
  const r = h.requests[0]!;
  expect(r.url.href).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`);
  expect(r.init.method).toBe('POST');
  expect(r.json.requests).toHaveLength(1);
  return r.json.requests[0];
}

test('The tool surface is exactly the pinned Sheets definitions with matching risk', () => {
  const tools = sheetsTools();
  const pinned = referenceTools.sheets;
  expect(tools.map(t => t.name).sort()).toEqual(pinned.map(t => t.name).sort());
  const destructive = ['batch_clear_values', 'clear_range', 'delete_chart', 'delete_named_range', 'delete_rows_or_columns', 'delete_sheet_tab', 'unprotect_range'];
  for (const reference of pinned) {
    const tool = tools.find(t => t.name === reference.name)!;
    expect(tool.description).toBe(reference.description);
    const { additionalProperties, ...schema } = tool.inputSchema;
    expect({ ...schema, additionalProperties }).toEqual({ ...(reference.inputSchema as any), required: reference.inputSchema.required ?? [], additionalProperties: false });
    expect(tool.annotations.readOnlyHint).toBe(reference.annotations.readOnlyHint);
    expect(tool.annotations.destructiveHint).toBe(destructive.includes(reference.name));
  }
});

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
