import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import source from '../reference/grok-catalog-2026-09-30.json';
import parity from '../reference/grok-catalog-2026-09-30-parity.json';
import managed from '../src/prompts/managed-skills.json';
import { AgentDataStore } from '../src/agent-data';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

test('catalog preserves source provenance and excludes retired workflows',()=>{
  expect(source.skills).toHaveLength(47);
  expect(managed.skills).toHaveLength(22);
  const installed=new Map(managed.skills.map(s=>[s.id,s.content]));
  expect(new Set(managed.skills.map(s=>s.id)).size).toBe(managed.skills.length);
  for(const item of source.skills){
    expect(hash(item.content)).toBe(item.sha256);
    const record=parity.skills.find(s=>s.id===item.id)!;
    expect(record.sourceSha256).toBe(item.sha256);
    if(record.status==='reference-only'){
      expect(installed.has(item.id)).toBe(false);
      continue;
    }
    expect(hash(installed.get(item.id)!)).toBe(record.installedSha256!);
  }
  for(const item of managed.skills){
    const front=yaml(item.content.split('---')[1]!);
    expect(front.name).toBe(item.id);expect(front.description.trim().length).toBeGreaterThan(10);
    expect(item.id).not.toBe('sign-in');
    expect(item.id.startsWith('site-playbooks-')).toBe(false);
    expect(item.content).not.toContain('`sign-in`');
    expect(item.content).not.toContain('site-playbooks-');
  }
});

test('every built-in has an unchanged source file, including unavailable backend workflows', async () => {
  for (const item of source.skills) {
    const file = join(import.meta.dir, '../reference/grok-builtins-2026-09-30/skills', item.id, 'SKILL.md');
    expect(await readFile(file, 'utf8')).toBe(item.content);
  }
});

test.each(['cached', 'missing', 'disabled'] as const)('retires cached skills with %s metadata without touching user or plugin skills', async (state) => {
  const root = await mkdtemp(join(tmpdir(), 'retired-skills-'));
  const data = join(root, 'data');
  const store = new AgentDataStore({} as never, { root: data, workspaceRoot: join(root, 'workspace') });
  const previous = process.env.OPENTEAM_MANAGED_SKILLS;
  delete process.env.OPENTEAM_MANAGED_SKILLS;
  try {
    if (state === 'cached') await store.syncPluginSkillCache([]);
    const retired = source.skills.filter(skill => skill.id === 'sign-in' || skill.id.startsWith('site-playbooks-'));
    for (const skill of retired) {
      const directory = join(data, 'managed-skills', skill.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'SKILL.md'), skill.content);
    }
    const personal = join(data, 'workflows', 'sign-in', 'SKILL.md');
    const plugin = join(data, 'plugins', 'site-playbooks-custom', 'SKILL.md');
    for (const file of [personal, plugin]) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'user-owned skill');
    }
    if (state === 'disabled') process.env.OPENTEAM_MANAGED_SKILLS = 'false';
    await store.syncPluginSkillCache([]);
    for (const skill of retired) {
      await expect(access(join(data, 'managed-skills', skill.id))).rejects.toThrow();
    }
    for (const file of [personal, plugin]) expect(await readFile(file, 'utf8')).toBe('user-owned skill');
    const cache = JSON.parse(await readFile(join(data, 'managed-skills', 'cache.json'), 'utf8'));
    expect(cache.skills.map((skill: { id: string }) => skill.id)).toEqual(state === 'disabled' ? [] : managed.skills.map(skill => skill.id));
    const rendered = await (store as any).renderManagedSkills();
    expect(rendered).not.toContain('managed:sign-in');
    expect(rendered).not.toContain('site-playbooks-');
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_MANAGED_SKILLS;
    else process.env.OPENTEAM_MANAGED_SKILLS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('all imported recipes materialize and appear in metadata without injecting full bodies',async()=>{
  const root=await mkdtemp(join(tmpdir(),'catalog-parity-'));
  const store=new AgentDataStore({} as never,{root:join(root,'data'),workspaceRoot:join(root,'workspace')});
  try{
    await store.syncPluginSkillCache([]);
    const cache=JSON.parse(await readFile(join(root,'data/managed-skills/cache.json'),'utf8'));
    expect(cache.skills).toHaveLength(managed.skills.length);
    for(const skill of managed.skills){
      const entry=cache.skills.find((s:any)=>s.id===skill.id);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.content).toBeUndefined();
      expect(await readFile(entry.filePath,'utf8')).toBe(skill.content);
    }
    const rendered=await (store as any).renderManagedSkills();
    for(const skill of managed.skills)expect(rendered).toContain(`managed:${skill.id}`);
    expect(rendered).not.toContain('function tfs(');
  }finally{await rm(root,{recursive:true,force:true});}
});
