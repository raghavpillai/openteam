import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import managed from '../src/prompts/managed-skills.json';
import { AgentDataStore } from '../src/agent-data';
import { buildGroupTurnPrompt } from '../src/index';
import { managedSkillIsForMain } from '../src/managed-skill-agents';

const skill = (id: string) => managed.skills.find(s => s.id === id)!.content;
const description = (id: string): string => yaml(skill(id).split('---')[1]!).description;

test('the group-chat-turns trigger names the tag a room turn starts with', () => {
  const turn = buildGroupTurnPrompt({ groupName: 'Launch', targetId: 'a', targetName: 'A', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], messages: [{ sender: 'user', content: 'hi' }] });
  const tag = description('group-chat-turns').match(/starts with a (\[[^"]*")/)![1]!;
  expect(turn.startsWith(tag)).toBe(true);
  expect(skill('group-chat-turns')).toContain('in a room you never hand it over or have anyone sign in on it');
  // Each room keeps its own context and gets plain text only.
  expect(skill('group-chat-turns')).not.toContain('Your one conversation carries');
  expect(skill('group-chat-turns')).toContain('Only plain text reaches the room');
});

test('managed workflows omit categorical authentication and transaction handovers', () => {
  const workflows = managed.skills.map(skill => skill.content).join('\n');
  for (const legacy of [
    'Use `request_box_help` when a form cannot express the step: captcha, passkey',
    'Keep request_box_help for steps a form cannot express: puzzle or image captchas',
    'Any payment confirmation the site asks for goes to the user',
    'Hand off provider-required bank authentication, CVC or 3DS steps',
    'is a sign-up the user does; hand it over',
    'REQUIRED before any typed web step',
  ]) expect(workflows).not.toContain(legacy);
});

test('connector skills install without asking and promise no connect card', () => {
  // OpenTeam has no connect cards: InstallPlugin installs, AuthenticateMcpServer starts sign-in.
  for (const item of managed.skills.filter(s => s.id !== 'routines')) {
    expect(item.content).not.toMatch(/connect card (is the ask|appears|handles|is shown)/);
    expect(item.content).not.toContain('once the user agrees, install it');
  }
  expect(skill('no-connector-fallback')).toContain('Install a missing connector with InstallPlugin without asking.');
  expect(skill('no-connector-fallback')).toContain('a row reading needsAuth is a connector, so call AuthenticateMcpServer and never open the box for that service');
  expect(skill('add-connector')).toContain('**Only related plugins match**');
  expect(skill('add-connector')).toContain('You are not resumed when sign-in finishes.');
});

test('purchases takes the user\'s own card and keeps no card', () => {
  expect(description('purchases')).toContain('Always follow this when dealing with credit cards');
  const purchases = skill('purchases');
  for (const rule of [
    'call RequestUserForm with reason "checkout"',
    'use them as given for this checkout, without asking them to re-enter the card in the Secure Form',
    "Never tell the user you can't take their card",
    'OpenTeam does not keep cards',
    'verify whether the order went through (confirmation page, order history, email) before retrying',
  ]) expect(purchases).toContain(rule);
  // The form host cannot reach cross-origin card frames, so those go to the screen handoff.
  expect(purchases).toContain('Card inputs inside a cross-origin frame');
});

test('commerce skills pay in the purchases order and keep no confirmation leftovers', () => {
  for (const item of managed.skills) {
    const lines = item.content.split('\n');
    const long = lines.filter(line => line.length > 40);
    expect([item.id, new Set(long).size]).toEqual([item.id, long.length]);
    let next: number | undefined;
    for (const line of lines) {
      if (line.startsWith('#')) { next = undefined; continue; }
      const step = Number(line.match(/^(\d+)\. /)?.[1]);
      if (!step) continue;
      if (next === undefined || step === 1) next = step;
      expect(`${item.id} ${step}`).toBe(`${item.id} ${next}`);
      next = step + 1;
    }
    if (item.id === 'routines' || item.id === 'box-desktop') continue;
    expect(item.content).not.toMatch(/site playbook|A dismissed widget is a no|confirm with a widget|RequestVirtualCard|Stripe Link|Outlook|GetMcpTools/i);
    if (item.content.includes('When the site wants payment')) expect(item.content).toContain('as the OpenTeam-managed `purchases` skill says');
  }
  expect(managed.skills.filter(s => s.content.includes('When the site wants payment')).map(s => s.id).sort()).toEqual(
    ['accommodation-booking', 'flight-booking', 'food-ordering', 'restaurant-booking', 'scheduling'],
  );
  expect(skill('restaurant-booking')).toContain('Offer once to add the reservation to their calendar.');
  expect(skill('flight-booking')).toContain("through the user's mail connector (Gmail or an Email plugin inbox)");
});

test('catalog has valid skill metadata and excludes retired workflows',()=>{
  expect(managed.skills).toHaveLength(25);
  expect(new Set(managed.skills.map(s=>s.id)).size).toBe(managed.skills.length);
  for(const item of managed.skills){
    const front=yaml(item.content.split('---')[1]!);
    expect(front.name).toBe(item.id);expect(front.description.trim().length).toBeGreaterThan(10);
    expect(item.id).not.toBe('sign-in');
    expect(item.id).not.toBe('source-control');
    expect(item.id).not.toBe('voice-calls');
    expect(item.id.startsWith('site-playbooks-')).toBe(false);
    expect(item.content).not.toContain('`sign-in`');
    expect(item.content).not.toContain('site-playbooks-');
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
    const retired = ['sign-in', 'site-playbooks-airbnb', 'site-playbooks-google-flights', 'removed-custom-workflow'];
    for (const id of retired) {
      const directory = join(data, 'managed-skills', id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Retired workflow fixture\n---\nRetired instructions.\n`);
    }
    const personal = join(data, 'workflows', 'sign-in', 'SKILL.md');
    const plugin = join(data, 'plugins', 'site-playbooks-custom', 'SKILL.md');
    for (const file of [personal, plugin]) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'user-owned skill');
    }
    if (state === 'disabled') process.env.OPENTEAM_MANAGED_SKILLS = 'false';
    await store.syncPluginSkillCache([]);
    for (const id of retired) {
      await expect(access(join(data, 'managed-skills', id))).rejects.toThrow();
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

test('active skills materialize and appear in metadata without injecting full bodies',async()=>{
  const root=await mkdtemp(join(tmpdir(),'managed-catalog-'));
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
    for(const skill of managed.skills.filter(managedSkillIsForMain))expect(rendered).toContain(`managed:${skill.id}`);
    expect(rendered).not.toContain('function tfs(');
  }finally{await rm(root,{recursive:true,force:true});}
});
