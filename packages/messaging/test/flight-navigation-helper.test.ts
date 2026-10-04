import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDataStore } from '../src/agent-data';

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
    expect(await readFile(join(directory,'SKILL.md'),'utf8')).not.toContain('site-playbooks-');
    await expect(access(join(root,'agent-data/managed-skills/site-playbooks-google-flights'))).rejects.toThrow();
    await writeFile(helper,'stale helper restored from old cache');
    await store.syncPluginSkillCache([]);
    await expect(access(helper)).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
});
