import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import source from '../reference/grok-catalog-2026-09-30.json';
import parity from '../reference/grok-catalog-2026-09-30-parity.json';
import managed from '../src/prompts/managed-skills.json';
import { AgentDataStore } from '../src/agent-data';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

test('catalog preserves verified recipes with documented action-review adaptations',()=>{
  expect(source.skills).toHaveLength(47);
  expect(managed.skills).toHaveLength(45);
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
    if(item.id.startsWith('site-playbooks-') && record.status !== 'adapted')expect(installed.get(item.id)).toBe(item.content.replaceAll('RequestUserForm', 'request_user_form'));
  }
  expect(installed.get('site-playbooks-doordash')).not.toContain("widget's yes");
  expect(installed.get('site-playbooks-doordash')).not.toContain('lines the widget read back');
  for(const item of managed.skills){
    const front=yaml(item.content.split('---')[1]!);
    expect(front.name).toBe(item.id);expect(front.description.trim().length).toBeGreaterThan(10);
    for(const match of item.content.matchAll(/`(site-playbooks-[a-z]+(?:-[a-z]+)*)`/g))expect(installed.has(match[1]!)).toBe(true);
  }
});

test('every built-in has an unchanged source file, including unavailable backend workflows', async () => {
  for (const item of source.skills) {
    const file = join(import.meta.dir, '../reference/grok-builtins-2026-09-30/skills', item.id, 'SKILL.md');
    expect(await readFile(file, 'utf8')).toBe(item.content);
  }
  const signIn = managed.skills.find(skill => skill.id === 'sign-in')!.content;
  expect(signIn).toContain('request_user_form');
  expect(signIn).toContain('If it is unavailable, continue to the Secure Form');
  expect(signIn).not.toContain('RequestUserForm');
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
