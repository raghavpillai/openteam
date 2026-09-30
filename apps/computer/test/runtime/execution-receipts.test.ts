import {expect, test} from 'bun:test';
import {executionReceipts} from '../../src/runtime/prompt-context';
import {NativeToolExecutor} from '../../src/native-tool-executor';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a real signal-terminated shell is a failed receipt even without an exit code', async () => {
 const root = await mkdtemp(join(tmpdir(), 'receipt-signal-'));
 try {
  const executor = new NativeToolExecutor({agentDir:root,controlToken:'synthetic'});
  const result = await executor.shell({command:'kill -TERM $$',block_until_ms:1000},root,undefined,undefined,'receipt-test');
  expect(result.details).toMatchObject({status:'completed',exitCode:null});
  const receipts = executionReceipts([{role:'toolResult',toolCallId:'killed',toolName:'Shell',timestamp:120,...result}],100,130);
  expect(receipts[0]!.content).toContain('"Shell":{"returned":1,"failed":1}');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('background shell receipts distinguish failure, success and pending null exit codes', () => {
 const details = [
  {status:'completed',exit_code:2},
  {status:'completed',exit_code:null},
  {status:'failed',exit_code:null},
  {status:'running',exit_code:null},
  {status:'completed',exit_code:0},
 ];
 const result = executionReceipts(details.map((value,i)=>({role:'toolResult',toolCallId:String(i),toolName:'AwaitShell',timestamp:120,details:value})),100,130);
 expect(result[0]!.content).toContain('"AwaitShell":{"returned":5,"failed":3}');
});
test('host counts returned receipts, unwraps dynamic names, deduplicates and scopes timestamps', () => {
 const result = executionReceipts([
  {role:'assistant',content:[{type:'toolCall',id:'a',name:'CallDynamicTool',arguments:{toolName:'WebFetch'}}]},
  {role:'toolResult',toolCallId:'a',toolName:'CallDynamicTool',timestamp:120,isError:true},
  {role:'toolResult',toolCallId:'a',toolName:'CallDynamicTool',timestamp:120,isError:true},
  {role:'toolResult',toolCallId:'b',toolName:'Shell',timestamp:121,details:{exitCode:127}},
  {role:'toolResult',toolCallId:'old',toolName:'WebSearch',timestamp:90},
  {role:'assistant',content:[{type:'toolCall',id:'pending',name:'Read'}]},
 ],100,130);
 expect(result[0]!.content).toContain('"WebFetch":{"returned":1,"failed":1}');
 expect(result[0]!.content).toContain('"Shell":{"returned":1,"failed":1}');
 expect(result[0]!.content).not.toContain('WebSearch');
 expect(result[0]!.content).not.toContain('"Read"');
 expect(result[0]!.content).toContain('Do not label this whole-task totals');
 expect(executionReceipts([],100)).toEqual([]);
});
