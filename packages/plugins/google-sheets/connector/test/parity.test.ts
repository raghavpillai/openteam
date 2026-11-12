import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { referenceTools } from '../../../_shared/reference';
import { harness } from '../../../test/parity-harness';
import { readCap, sheetsTools } from '../server';

const sheets = (responses: any[] = []) => harness(api => sheetsTools(api.at('https://sheets.googleapis.com')), responses);
const id = 'sheet123';
const batchReply = (reply: any = {}) => ({ spreadsheetId: id, replies: [reply] });
const apiError = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
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

test('get_spreadsheet asks for structure only and restores zero-valued sheet ids', async () => {
  const h = sheets([{ spreadsheetId: id, sheets: [{ properties: { title: 'Sheet1', gridProperties: { rowCount: 1000 } } }, { properties: { sheetId: 9, index: 1, title: 'Data' }, charts: [{ chartId: 4, spec: { title: 'Revenue' } }] }] }]);
  const value = await h.call('get_spreadsheet', { spreadsheetId: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0` });
  const url = h.requests[0]!.url;
  expect(url.pathname).toBe(`/v4/spreadsheets/${id}`);
  expect(url.searchParams.get('includeGridData')).toBe('false');
  const fields = url.searchParams.get('fields')!;
  for (const field of ['spreadsheetUrl', 'sheetId', 'title', 'index', 'sheetType', 'hidden', 'rowCount', 'columnCount', 'frozenRowCount', 'charts(chartId,spec(title))', 'protectedRanges(protectedRangeId', 'namedRanges(namedRangeId,name,range)']) expect(fields).toContain(field);
  expect(fields).not.toContain('data');
  expect(value.sheets[0].properties).toEqual({ sheetId: 0, index: 0, title: 'Sheet1', gridProperties: { rowCount: 1000 } });
  expect(value.sheets[1].charts[0].chartId).toBe(4);
});

test('create_spreadsheet creates named tabs in order and returns ids and titles', async () => {
  const h = sheets([{ spreadsheetId: 'new', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new/edit', properties: { title: 'Budget' }, sheets: [{ properties: { title: 'Summary', index: 0 } }, { properties: { sheetId: 55, title: 'Data', index: 1 } }] }]);
  const value = await h.call('create_spreadsheet', { title: 'Budget', sheetTitles: ['Summary', 'Data'] });
  expect(h.requests[0]!.url.pathname).toBe('/v4/spreadsheets');
  expect(h.requests[0]!.init.method).toBe('POST');
  expect(h.requests[0]!.json).toEqual({ properties: { title: 'Budget' }, sheets: [{ properties: { title: 'Summary', index: 0 } }, { properties: { title: 'Data', index: 1 } }] });
  expect(value).toEqual({ spreadsheetId: 'new', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new/edit', title: 'Budget', sheets: [{ sheetId: 0, title: 'Summary' }, { sheetId: 55, title: 'Data' }] });
  const plain = sheets([{ spreadsheetId: 'x', properties: { title: 'Plain' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }]);
  await plain.call('create_spreadsheet', { title: 'Plain' });
  expect(plain.requests[0]!.json).toEqual({ properties: { title: 'Plain' } });
  await expect(sheets().call('create_spreadsheet', { title: 'Dup', sheetTitles: ['Data', 'data'] })).rejects.toThrow('unique');
});

test('read_range batches quoted ranges, defaults to formatted values and renders CSV sections', async () => {
  const h = sheets([{ spreadsheetId: id, valueRanges: [
    { range: "'Q1 Sales'!A1:C3", values: [['Region', 'Total', 'Note'], ['West', '$1,234.50', 'big, round'], ['East', '$99.00']] },
    { range: 'Sheet1!B2:B5', values: [['x']] },
    { range: "'It''s'!A1:Z1000", values: [] },
  ] }]);
  const value = await h.call('read_range', { spreadsheetId: id, ranges: [{ sheet: 'Q1 Sales', cells: 'a1:c3' }, { cells: 'B2:B5' }, { sheet: "It's" }] });
  const url = h.requests[0]!.url;
  expect(url.pathname).toBe(`/v4/spreadsheets/${id}/values:batchGet`);
  expect(url.searchParams.getAll('ranges')).toEqual(["'Q1 Sales'!A1:C3", 'B2:B5', "'It''s'"]);
  expect(url.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE');
  expect(url.searchParams.get('majorDimension')).toBe('ROWS');
  expect(value).toEqual({ spreadsheetId: id, truncated: false, sections: [
    { sheet: 'Q1 Sales', range: 'A1:C3', csv: 'Region,Total,Note\nWest,"$1,234.50","big, round"\nEast,$99.00' },
    { sheet: 'Sheet1', range: 'B2:B5', csv: 'x' },
    { sheet: "It's", range: 'A1:Z1000', csv: '' },
  ] });
});

test('read_range finds the first visible tab when a range names neither tab nor cells', async () => {
  const h = sheets([{ sheets: [{ properties: { title: 'Hidden', hidden: true } }, { properties: { title: 'Visible' } }] }, { spreadsheetId: id, valueRanges: [{ range: 'Visible!A1:Z1000', values: [[1, true]] }] }]);
  const value = await h.call('read_range', { spreadsheetId: id, ranges: [{}], valueRenderOption: 'UNFORMATTED_VALUE' });
  expect(h.requests[0]!.url.searchParams.get('fields')).toBe('sheets.properties(title,hidden)');
  expect(h.requests[1]!.url.searchParams.getAll('ranges')).toEqual(["'Visible'"]);
  expect(h.requests[1]!.url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
  expect(value.sections[0]).toEqual({ sheet: 'Visible', range: 'A1:Z1000', csv: '1,TRUE' });
});

test('read_range truncates at maxChars with a continuation that reads the remaining rows', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => [`row${i + 1}`, 'x'.repeat(10)]);
  const h = sheets([{ spreadsheetId: id, valueRanges: [{ range: 'Data!A1:B100', values: rows }] }, { spreadsheetId: id, valueRanges: [{ range: 'Data!A11:B100', values: rows.slice(10) }] }]);
  const first = await h.call('read_range', { spreadsheetId: id, ranges: [{ sheet: 'Data', cells: 'A:B' }], maxChars: 170 });
  expect(first.truncated).toBe(true);
  expect(first.sections[0].csv.split('\n')).toHaveLength(10);
  expect(first.sections[0].csv.length).toBeLessThanOrEqual(170);
  expect(first.sections[0].nextCells).toBe('A11:B100');
  const next = await h.call('read_range', { spreadsheetId: id, ranges: [{ sheet: 'Data', cells: first.sections[0].nextCells }], maxChars: 250000 });
  expect(h.requests[1]!.url.searchParams.getAll('ranges')).toEqual(["'Data'!A11:B100"]);
  expect(next.truncated).toBe(false);
  expect(next.sections[0].csv.split('\n')[0]).toBe('row11,xxxxxxxxxx');
});

test('read_range turns an oversized raw response into a row-window instruction', async () => {
  const h = sheets([new Response('x'.repeat(readCap + 1), { headers: { 'content-type': 'application/json' } })]);
  await expect(h.call('read_range', { spreadsheetId: id, ranges: [{ sheet: 'Data' }] })).rejects.toThrow('cells "1:2000"');
});

test('Unknown tab titles get an actionable hint', async () => {
  const h = sheets([apiError(400, "Unable to parse range: 'Nope'!A1")]);
  await expect(h.call('read_range', { spreadsheetId: id, ranges: [{ sheet: 'Nope', cells: 'A1' }] })).rejects.toThrow('get_spreadsheet');
});

test('write_range writes RAW by default and USER_ENTERED with parseInput', async () => {
  const h = sheets([
    { spreadsheetId: id, totalUpdatedCells: 4, responses: [{ updatedRange: "'My Tab'!B2:C3", updatedCells: 4 }] },
    { spreadsheetId: id, totalUpdatedCells: 1, responses: [{ updatedRange: 'Data!A1', updatedCells: 1 }] },
  ]);
  const value = await h.call('write_range', { spreadsheetId: id, sheet: 'My Tab', cells: 'b2', values: [['=SUM(A1:A3)', '2026-01-31'], [1, true]] });
  const r = h.requests[0]!;
  expect(r.url.pathname).toBe(`/v4/spreadsheets/${id}/values:batchUpdate`);
  expect(r.init.method).toBe('POST');
  expect(r.json).toEqual({ valueInputOption: 'RAW', data: [{ range: "'My Tab'!B2:C3", majorDimension: 'ROWS', values: [['=SUM(A1:A3)', '2026-01-31'], [1, true]] }] });
  expect(value).toEqual({ spreadsheetId: id, updatedRange: "'My Tab'!B2:C3", updatedCells: 4 });
  await h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1:A1', values: [['=1+1']], parseInput: true });
  expect(h.requests[1]!.json.valueInputOption).toBe('USER_ENTERED');
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

test('write_range grows the tab grid once when the write exceeds it', async () => {
  const h = sheets([
    apiError(400, "Range ('Data'!A1000:AB1001) exceeds grid limits. Max rows: 1000, max columns: 26"),
    { sheets: [{ properties: { sheetId: 0, title: 'Other' } }, { properties: { sheetId: 7, title: 'Data', gridProperties: { rowCount: 1000, columnCount: 26 } } }] },
    batchReply(),
    { spreadsheetId: id, responses: [{ updatedRange: 'Data!A1000:AB1001', updatedCells: 56 }] },
  ]);
  const value = await h.call('write_range', { spreadsheetId: id, sheet: 'Data', cells: 'A1000', values: [Array(28).fill(1), Array(28).fill(2)] });
  expect(h.requests[2]!.json.requests).toEqual([{ appendDimension: { sheetId: 7, dimension: 'ROWS', length: 1 } }, { appendDimension: { sheetId: 7, dimension: 'COLUMNS', length: 2 } }]);
  expect(h.requests[3]!.json).toEqual(h.requests[0]!.json);
  expect(value.updatedRange).toBe('Data!A1000:AB1001');
});

test('append_rows finds the table in the tab and inserts rows unless told to overwrite', async () => {
  const reply = { spreadsheetId: id, tableRange: 'Data!A1:C10', updates: { updatedRange: 'Data!A11:C11', updatedCells: 3 } };
  const h = sheets([reply, reply]);
  expect(await h.call('append_rows', { spreadsheetId: id, sheet: 'Data', values: [['a', null, 3]] })).toEqual(reply);
  let r = h.requests[0]!;
  expect(r.url.pathname).toBe(`/v4/spreadsheets/${id}/values/'Data':append`);
  expect(r.url.searchParams.get('valueInputOption')).toBe('RAW');
  expect(r.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
  expect(r.json).toEqual({ majorDimension: 'ROWS', values: [['a', null, 3]] });
  await h.call('append_rows', { spreadsheetId: id, sheet: 'Sales 2026', cells: 'A1:D', values: [['=A1']], parseInput: true, insertRows: false });
  r = h.requests[1]!;
  expect(decodeURIComponent(r.url.pathname)).toBe(`/v4/spreadsheets/${id}/values/'Sales 2026'!A:D:append`);
  expect(r.url.searchParams.get('valueInputOption')).toBe('USER_ENTERED');
  expect(r.url.searchParams.get('insertDataOption')).toBe('OVERWRITE');
  await expect(h.call('append_rows', { spreadsheetId: id, sheet: 'a\\b', values: [[1]] })).rejects.toThrow('rename_sheet_tab');
});

test('append_values passes the raw A1 range and stores values literally', async () => {
  const h = sheets([{ spreadsheetId: id, updates: { updatedRange: 'Sheet1!A5:B5' } }]);
  await h.call('append_values', { spreadsheetId: id, range: 'Sheet1!A1:D', values: [['=1+1', 2]] });
  const r = h.requests[0]!;
  expect(decodeURIComponent(r.url.pathname)).toBe(`/v4/spreadsheets/${id}/values/Sheet1!A1:D:append`);
  expect(r.url.searchParams.get('valueInputOption')).toBe('RAW');
  expect(r.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
  expect(r.json.values).toEqual([['=1+1', 2]]);
  await expect(h.call('append_values', { spreadsheetId: id, range: 'Sheet1', values: [Array(10001).fill(1)] })).rejects.toThrow('at most 10000');
});

test('clear_range and batch_clear_values clear values and return the cleared ranges', async () => {
  const h = sheets([{ spreadsheetId: id, clearedRange: 'Data!A1:D50' }, { spreadsheetId: id, clearedRanges: ['Sheet1!A2:D1000', 'Sheet2!B1:B1000'] }]);
  expect(await h.call('clear_range', { spreadsheetId: id, sheet: 'Data', cells: 'a1:d50' })).toEqual({ spreadsheetId: id, clearedRange: 'Data!A1:D50' });
  expect(decodeURIComponent(h.requests[0]!.url.pathname)).toBe(`/v4/spreadsheets/${id}/values/'Data'!A1:D50:clear`);
  expect(h.requests[0]!.init.method).toBe('POST');
  expect((await h.call('batch_clear_values', { spreadsheetId: id, ranges: ['Sheet1!A2:D', 'Sheet2!B:B'] })).clearedRanges).toHaveLength(2);
  expect(h.requests[1]!.url.pathname).toBe(`/v4/spreadsheets/${id}/values:batchClear`);
  expect(h.requests[1]!.json).toEqual({ ranges: ['Sheet1!A2:D', 'Sheet2!B:B'] });
});

test('Tab tools add, rename, delete and copy tabs', async () => {
  expect(await request('add_sheet_tab', { title: 'Summary', index: 0 })).toEqual({ addSheet: { properties: { title: 'Summary', index: 0 } } });
  expect(await request('add_sheet_tab', { title: 'Last' })).toEqual({ addSheet: { properties: { title: 'Last' } } });
  expect(await request('rename_sheet_tab', { sheetId: 0, title: 'Q1-Q2' })).toEqual({ updateSheetProperties: { properties: { sheetId: 0, title: 'Q1-Q2' }, fields: 'title' } });
  expect(await request('delete_sheet_tab', { sheetId: 4 })).toEqual({ deleteSheet: { sheetId: 4 } });
  const h = sheets([{ sheetId: 99, title: 'Copy of Data', index: 3 }]);
  expect(await h.call('copy_sheet_to_another_spreadsheet', { spreadsheetId: id, sheetId: 12, destinationSpreadsheetId: 'https://docs.google.com/spreadsheets/d/dest_1/edit' })).toEqual({ sheetId: 99, title: 'Copy of Data', index: 3 });
  expect(h.requests[0]!.url.pathname).toBe(`/v4/spreadsheets/${id}/sheets/12:copyTo`);
  expect(h.requests[0]!.json).toEqual({ destinationSpreadsheetId: 'dest_1' });
});

test('Row and column tools convert 1-based positions to dimension ranges', async () => {
  expect(await request('insert_rows_or_columns', { sheetId: 3, dimension: 'ROWS', position: 5, count: 2 })).toEqual({ insertDimension: { range: { sheetId: 3, dimension: 'ROWS', startIndex: 4, endIndex: 6 }, inheritFromBefore: false } });
  expect(await request('insert_rows_or_columns', { sheetId: 3, dimension: 'COLUMNS', position: 2, inheritBefore: true })).toEqual({ insertDimension: { range: { sheetId: 3, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, inheritFromBefore: true } });
  await expect(sheets().call('insert_rows_or_columns', { spreadsheetId: id, sheetId: 3, dimension: 'ROWS', position: 1, inheritBefore: true })).rejects.toThrow('position 1');
  expect(await request('delete_rows_or_columns', { sheetId: 3, dimension: 'COLUMNS', position: 1 })).toEqual({ deleteDimension: { range: { sheetId: 3, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 } } });
  expect(await request('set_column_width', { sheetId: 3, dimension: 'COLUMNS', position: 2, count: 3, pixelSize: 180 })).toEqual({ updateDimensionProperties: { range: { sheetId: 3, dimension: 'COLUMNS', startIndex: 1, endIndex: 4 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } });
  expect(await request('freeze_rows_or_columns', { sheetId: 3, frozenRowCount: 1 })).toEqual({ updateSheetProperties: { properties: { sheetId: 3, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
  expect(await request('freeze_rows_or_columns', { sheetId: 3, frozenRowCount: 0, frozenColumnCount: 2 })).toEqual({ updateSheetProperties: { properties: { sheetId: 3, gridProperties: { frozenRowCount: 0, frozenColumnCount: 2 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } });
  await expect(sheets().call('freeze_rows_or_columns', { spreadsheetId: id, sheetId: 3 })).rejects.toThrow('frozenRowCount');
});

test('format_cells sends only the given properties with a matching field mask', async () => {
  expect(await request('format_cells', { sheetId: 0, cells: 'A1:D1', bold: true, textColor: '#FFFFFF', backgroundColor: '#1F4E79', horizontalAlignment: 'CENTER', numberFormatPattern: '$#,##0' })).toEqual({ repeatCell: {
    range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
    cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } }, backgroundColorStyle: { rgbColor: { red: 31 / 255, green: 78 / 255, blue: 121 / 255 } }, horizontalAlignment: 'CENTER', numberFormat: { type: 'CURRENCY', pattern: '$#,##0' } } },
    fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColorStyle,userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat',
  } });
  const whole = await request('format_cells', { sheetId: 5, fontFamily: 'Roboto', fontSize: 11, italic: false, strikethrough: false, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' });
  expect(whole.repeatCell.range).toEqual({ sheetId: 5 });
  expect(whole.repeatCell.cell.userEnteredFormat).toEqual({ textFormat: { italic: false, strikethrough: false, fontSize: 11, fontFamily: 'Roboto' }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' });
});

test('set_borders styles outer edges and inner lines separately', async () => {
  const black = { rgbColor: { red: 0, green: 0, blue: 0 } };
  expect(await request('set_borders', { sheetId: 1, cells: 'A1:B2', outer: 'SOLID_MEDIUM', inner: 'DOTTED' })).toEqual({ updateBorders: {
    range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
    top: { style: 'SOLID_MEDIUM', colorStyle: black }, bottom: { style: 'SOLID_MEDIUM', colorStyle: black }, left: { style: 'SOLID_MEDIUM', colorStyle: black }, right: { style: 'SOLID_MEDIUM', colorStyle: black },
    innerHorizontal: { style: 'DOTTED', colorStyle: black }, innerVertical: { style: 'DOTTED', colorStyle: black },
  } });
  expect(await request('set_borders', { sheetId: 1, inner: 'NONE', color: '#FF0000' })).toEqual({ updateBorders: { range: { sheetId: 1 }, innerHorizontal: { style: 'NONE' }, innerVertical: { style: 'NONE' } } });
  await expect(sheets().call('set_borders', { spreadsheetId: id, sheetId: 1 })).rejects.toThrow('outer and/or inner');
});

test('merge_cells merges by type or unmerges', async () => {
  const range = { sheetId: 2, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 };
  expect(await request('merge_cells', { sheetId: 2, cells: 'A1:C1', mergeType: 'MERGE_ALL' })).toEqual({ mergeCells: { range, mergeType: 'MERGE_ALL' } });
  expect(await request('merge_cells', { sheetId: 2, cells: 'A1:C1', mergeType: 'UNMERGE' })).toEqual({ unmergeCells: { range } });
});

test('add_banding uses readable defaults and accepts custom colors', async () => {
  const banding = await request('add_banding', { sheetId: 0, cells: 'A1:D20' });
  expect(banding.addBanding.bandedRange.range).toEqual({ sheetId: 0, startRowIndex: 0, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 4 });
  expect(banding.addBanding.bandedRange.rowProperties.firstBandColorStyle).toEqual({ rgbColor: { red: 1, green: 1, blue: 1 } });
  expect(Object.keys(banding.addBanding.bandedRange.rowProperties)).toEqual(['headerColorStyle', 'firstBandColorStyle', 'secondBandColorStyle']);
  const custom = await request('add_banding', { sheetId: 0, cells: 'A1:D20', headerColor: '#000000', secondBandColor: '#00ff00' });
  expect(custom.addBanding.bandedRange.rowProperties.headerColorStyle).toEqual({ rgbColor: { red: 0, green: 0, blue: 0 } });
  expect(custom.addBanding.bandedRange.rowProperties.secondBandColorStyle).toEqual({ rgbColor: { red: 0, green: 1, blue: 0 } });
});

test('add_conditional_formatting builds a boolean rule with the format to apply', async () => {
  expect(await request('add_conditional_formatting', { sheetId: 0, cells: 'C2:C100', conditionType: 'NUMBER_GREATER', conditionValues: ['1000'], bold: true, backgroundColor: '#FFCCCC' })).toEqual({ addConditionalFormatRule: { index: 0, rule: {
    ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 100, startColumnIndex: 2, endColumnIndex: 3 }],
    booleanRule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '1000' }] }, format: { textFormat: { bold: true }, backgroundColorStyle: { rgbColor: { red: 1, green: 0.8, blue: 0.8 } } } },
  } } });
  const formula = await request('add_conditional_formatting', { sheetId: 0, cells: 'A2:D', conditionType: 'CUSTOM_FORMULA', conditionValues: ['=$D2<0'], textColor: '#FF0000' });
  expect(formula.addConditionalFormatRule.rule.booleanRule).toEqual({ condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$D2<0' }] }, format: { textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } } } } });
  await expect(sheets().call('add_conditional_formatting', { spreadsheetId: id, sheetId: 0, cells: 'A1', conditionType: 'BLANK' })).rejects.toThrow('format to apply');
  await expect(sheets().call('add_conditional_formatting', { spreadsheetId: id, sheetId: 0, cells: 'A1', conditionType: 'NUMBER_BETWEEN', conditionValues: ['1'], bold: true })).rejects.toThrow('takes 2 values');
});

test('set_data_validation sets dropdowns and checks, or clears with no condition', async () => {
  const range = { sheetId: 0, startRowIndex: 1, endRowIndex: 50, startColumnIndex: 1, endColumnIndex: 2 };
  expect(await request('set_data_validation', { sheetId: 0, cells: 'B2:B50', conditionType: 'ONE_OF_LIST', conditionValues: ['Open', 'Done'] })).toEqual({ setDataValidation: { range, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Open' }, { userEnteredValue: 'Done' }] }, strict: true, showCustomUi: true } } });
  expect(await request('set_data_validation', { sheetId: 0, cells: 'B2:B50', conditionType: 'NUMBER_BETWEEN', conditionValues: ['0', '10'], strict: false })).toEqual({ setDataValidation: { range, rule: { condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '0' }, { userEnteredValue: '10' }] }, strict: false } } });
  expect(await request('set_data_validation', { sheetId: 0, cells: 'B2:B50' })).toEqual({ setDataValidation: { range } });
  await expect(sheets().call('set_data_validation', { spreadsheetId: id, sheetId: 0, cells: 'B2', conditionValues: ['x'] })).rejects.toThrow('needs a conditionType');
  await expect(sheets().call('set_data_validation', { spreadsheetId: id, sheetId: 0, cells: 'B2', conditionType: 'ONE_OF_LIST' })).rejects.toThrow('at least one');
});

test('sort_range sorts by absolute column letters inside the range', async () => {
  expect(await request('sort_range', { sheetId: 0, cells: 'A2:D20', sortBy: [{ column: 'c', descending: true }, { column: 'A' }] })).toEqual({ sortRange: {
    range: { sheetId: 0, startRowIndex: 1, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 4 },
    sortSpecs: [{ dimensionIndex: 2, sortOrder: 'DESCENDING' }, { dimensionIndex: 0, sortOrder: 'ASCENDING' }],
  } });
  await expect(sheets().call('sort_range', { spreadsheetId: id, sheetId: 0, cells: 'B2:D20', sortBy: [{ column: 'A' }] })).rejects.toThrow('outside the sorted range B2:D20');
});

test('set_basic_filter sets a filter over the range or clears it', async () => {
  expect(await request('set_basic_filter', { sheetId: 4, cells: 'A1:D20' })).toEqual({ setBasicFilter: { filter: { range: { sheetId: 4, startRowIndex: 0, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 4 } } } });
  expect(await request('set_basic_filter', { sheetId: 4 })).toEqual({ clearBasicFilter: { sheetId: 4 } });
});

test('find_replace_sheet is literal and searches every tab unless one is named', async () => {
  expect(await request('find_replace_sheet', { find: 'a.b*', replacement: '' })).toEqual({ findReplace: { find: 'a.b*', replacement: '', matchCase: false, matchEntireCell: false, searchByRegex: false, includeFormulas: false, allSheets: true } });
  expect(await request('find_replace_sheet', { find: 'Q1', replacement: 'Q2', sheetId: 0, matchCase: true, matchEntireCell: true, searchFormulas: true })).toEqual({ findReplace: { find: 'Q1', replacement: 'Q2', matchCase: true, matchEntireCell: true, searchByRegex: false, includeFormulas: true, sheetId: 0 } });
});

test('add_chart uses the first range as the domain, later ranges as series, and anchors the chart', async () => {
  const col = (c: number) => ({ sheetId: 2, startRowIndex: 0, endRowIndex: 7, startColumnIndex: c, endColumnIndex: c + 1 });
  expect(await request('add_chart', { sheetId: 2, chartType: 'COLUMN', title: 'Revenue', ranges: [{ cells: 'A1:A7' }, { cells: 'B1:B7' }, { cells: 'C1:C7' }] })).toEqual({ addChart: { chart: {
    spec: { title: 'Revenue', basicChart: { chartType: 'COLUMN', legendPosition: 'BOTTOM_LEGEND', headerCount: 1,
      domains: [{ domain: { sourceRange: { sources: [col(0)] } } }],
      series: [{ series: { sourceRange: { sources: [col(1)] } }, targetAxis: 'LEFT_AXIS' }, { series: { sourceRange: { sources: [col(2)] } }, targetAxis: 'LEFT_AXIS' }] } },
    position: { overlayPosition: { anchorCell: { sheetId: 2, rowIndex: 1, columnIndex: 4 } } },
  } } });
  const bar = await request('add_chart', { sheetId: 2, chartType: 'BAR', ranges: [{ cells: 'A1:A7' }, { cells: 'B1:B7' }], headerCount: 0, legendPosition: 'NO_LEGEND', anchorCell: 'H20' });
  expect(bar.addChart.chart.spec.basicChart.series[0].targetAxis).toBe('BOTTOM_AXIS');
  expect(bar.addChart.chart.spec.basicChart.headerCount).toBe(0);
  expect(bar.addChart.chart.spec.basicChart.legendPosition).toBe('NO_LEGEND');
  expect(bar.addChart.chart.position.overlayPosition.anchorCell).toEqual({ sheetId: 2, rowIndex: 19, columnIndex: 7 });
});

test('PIE charts take labels then values and skip the header cells', async () => {
  const pie = await request('add_chart', { sheetId: 2, chartType: 'PIE', ranges: [{ cells: 'A1:A5' }, { cells: 'B:B' }] });
  expect(pie.addChart.chart.spec).toEqual({ pieChart: { legendPosition: 'BOTTOM_LEGEND',
    domain: { sourceRange: { sources: [{ sheetId: 2, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 }] } },
    series: { sourceRange: { sources: [{ sheetId: 2, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }] } } } });
  const noHeader = await request('add_chart', { sheetId: 2, chartType: 'PIE', headerCount: 0, ranges: [{ cells: 'A2:A5' }, { cells: 'B2:B5' }] });
  expect(noHeader.addChart.chart.spec.pieChart.domain.sourceRange.sources[0].startRowIndex).toBe(1);
  await expect(sheets().call('add_chart', { spreadsheetId: id, sheetId: 2, chartType: 'PIE', ranges: [{ cells: 'A1:A5' }, { cells: 'B1:B5' }, { cells: 'C1:C5' }] })).rejects.toThrow('exactly two ranges');
});

test('update_chart replaces the spec in place and delete_chart removes the chart', async () => {
  const update = await request('update_chart', { chartId: 77, sheetId: 2, chartType: 'LINE', title: 'Trend', ranges: [{ cells: 'A1:A7' }, { cells: 'B1:B7' }] });
  expect(Object.keys(update)).toEqual(['updateChartSpec']);
  expect(update.updateChartSpec.chartId).toBe(77);
  expect(update.updateChartSpec.spec.title).toBe('Trend');
  expect(update.updateChartSpec.spec.basicChart.chartType).toBe('LINE');
  expect(update.updateChartSpec.position).toBeUndefined();
  expect(await request('delete_chart', { chartId: 77 })).toEqual({ deleteEmbeddedObject: { objectId: 77 } });
});

test('Named ranges and protections map to their batchUpdate requests', async () => {
  expect(await request('add_named_range', { sheetId: 1, name: 'Budget_2026', cells: 'B2:B13' })).toEqual({ addNamedRange: { namedRange: { name: 'Budget_2026', range: { sheetId: 1, startRowIndex: 1, endRowIndex: 13, startColumnIndex: 1, endColumnIndex: 2 } } } });
  for (const name of ['AB12', 'R1C1', 'true']) await expect(sheets().call('add_named_range', { spreadsheetId: id, sheetId: 1, name, cells: 'A1' })).rejects.toThrow('looks like a cell reference');
  expect(await request('delete_named_range', { namedRangeId: 'nr1' })).toEqual({ deleteNamedRange: { namedRangeId: 'nr1' } });
  expect(await request('protect_range', { sheetId: 1, cells: 'A1:D1', description: 'Header' })).toEqual({ addProtectedRange: { protectedRange: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }, description: 'Header', warningOnly: true } } });
  expect(await request('protect_range', { sheetId: 1, warningOnly: false })).toEqual({ addProtectedRange: { protectedRange: { range: { sheetId: 1 }, warningOnly: false } } });
  expect(await request('unprotect_range', { protectedRangeId: 123 })).toEqual({ deleteProtectedRange: { protectedRangeId: 123 } });
});

test('Provider errors surface as tool errors without the token', async () => {
  const h = sheets([apiError(403, 'The caller does not have permission')]);
  const failure = await h.call('delete_sheet_tab', { spreadsheetId: id, sheetId: 1 }).catch(error => error as Error);
  expect(failure.message).toContain('Google API 403: The caller does not have permission');
  expect(failure.message).not.toContain('fixture-token');
  expect(h.requests[0]!.init.headers).toMatchObject({ Authorization: 'Bearer fixture-token' });
});

test('The stdio server lists exactly the pinned tools plus read_result and validates input', async () => {
  const client = new Client({ name: 'sheets-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '..', 'server.ts')], env: { GOOGLE_ACCESS_TOKEN: '' }, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual([...referenceTools.sheets.map(t => t.name), 'read_result'].sort());
    const invalid = await client.callTool({ name: 'read_range', arguments: { spreadsheetId: 'x', ranges: [], unexpected: true } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain('Invalid tool arguments');
    const unauthorized = await client.callTool({ name: 'get_spreadsheet', arguments: { spreadsheetId: 'x' } });
    expect(unauthorized.isError).toBe(true);
    expect(JSON.stringify(unauthorized)).toContain('not authorized');
  } finally { await client.close(); }
}, 20_000);
