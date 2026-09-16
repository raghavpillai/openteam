import { test, expect } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostShellCompletions } from '../src/host-shell-completions';
test('host shell completions survive restarts and retry delivery without re-polling settled jobs', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'host-wake-')); let polls = 0; let deliveries = 0;
 const first = new HostShellCompletions(directory, async () => { polls++; return { status: 'completed', waited_ms: 0, exit_code: 0 }; }, async () => { deliveries++; throw new Error('Server offline'); });
 try {
  await first.register({ botId: 'bot', automationRunId: 'automation-run', machineId: 'machine', shellId: '123', outputPath: '/tmp/123.log' }); await first.flush(); first.dispose();
  expect(polls).toBe(1); expect(deliveries).toBe(1);
  const second = new HostShellCompletions(directory, async () => { throw new Error('A settled job must not be polled again'); }, async (receipt) => { expect(receipt).toMatchObject({ scope: 'bot', automationRunId: 'automation-run', machineId: 'machine', hostShellId: '123', exitCode: 0 }); deliveries++; });
  try { await second.flush(); expect(deliveries).toBe(2); expect(await readdir(directory)).toEqual([]); } finally { second.dispose(); }
 } finally { first.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('observing host completion clears a deferred durable notification', async () => {
 const directory=await mkdtemp(join(tmpdir(),'host-observed-')); let active=true,delivered=0;
 const completions=new HostShellCompletions(directory,async()=>({status:'completed',waited_ms:0,exit_code:0}),async()=>{if(active)throw new Error('Turn active');delivered++;});
 try {
  await completions.register({botId:'bot',machineId:'machine',shellId:'42',outputPath:'/tmp/42.log'});
  await completions.flush();
  await completions.observe('bot','machine','42');
  active=false; await completions.flush();
  expect(delivered).toBe(0);expect(await readdir(directory)).toEqual([]);
 }finally{completions.dispose();await rm(directory,{recursive:true,force:true});}
});
