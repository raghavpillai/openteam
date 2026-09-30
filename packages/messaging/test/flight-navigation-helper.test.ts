import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { AgentDataStore } from '../src/agent-data';
import managedSkills from '../src/prompts/managed-skills.json';

test('managed cache retires the old helper even when the current skill is already cached', async () => {
  const root = await mkdtemp(join(tmpdir(),'flight-skill-'));
  const store = new AgentDataStore({} as never,{root:join(root,'agent-data'),workspaceRoot:join(root,'workspace')});
  const directory = join(root,'agent-data/managed-skills/flight-booking');
  const helper = join(directory,'google-flights-url.cjs');
  try {
    await mkdir(directory,{recursive:true});
    await writeFile(helper,'obsolete helper');
    await store.syncPluginSkillCache([]);
    await expect(access(helper)).rejects.toThrow();
    expect(await readFile(join(directory,'SKILL.md'),'utf8')).toContain('site-playbooks-google-flights');
    expect(await readFile(join(root,'agent-data/managed-skills/site-playbooks-google-flights/SKILL.md'),'utf8')).toContain('function tfs(');
    await writeFile(helper,'stale helper restored from old cache');
    await store.syncPluginSkillCache([]);
    await expect(access(helper)).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('inline navigation recipe encodes requested routes and both supported trip types', () => {
  const flight=managedSkills.skills.find(skill=>skill.id==='site-playbooks-google-flights')!;
  const code=flight.content.match(/```js\n([\s\S]*?)```/)![1]!;
  for (const input of [
    {oneway:true,origin:'SFO',dest:'CDG',depart:'2027-02-28'},
    {oneway:false,origin:'BOS',dest:'HND',depart:'2027-04-02',ret:'2027-04-15'},
  ]) {
    const encoded=runInNewContext(code+'\ntfs(input)',{Buffer,input});
    const payload=Buffer.from(encoded,'base64url');
    for(const value of [input.origin,input.dest,input.depart,...(input.ret?[input.ret]:[])]) expect(payload.toString()).toContain(value);
    // f19 trip type: round trip=1, one way=2; no model-generated URL fixture.
    expect([...payload.subarray(-3)]).toEqual([152,1,input.oneway?2:1]);
  }
});
