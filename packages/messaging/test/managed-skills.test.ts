import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yaml } from "yaml";
import { AUTOMATION_TRIGGER_SHAPE_LINES } from "@openteam/contracts/reference-main-parsers";
import { referenceTool } from "@openteam/contracts/tool-contracts";
import managed from "../src/prompts/managed-skills.json";
import { AgentDataStore } from "../src/agent-data";
import { buildGroupTurnPrompt } from "../src/index";
import { agentSkillItem, omittedSkillsNotice, renderSkillCatalog } from "../src/skill-catalog";

const skill = (id: string) => managed.skills.find((s) => s.id === id)!.content;
const description = (id: string): string => yaml(skill(id).split("---")[1]!).description;

let root = "";
let store: AgentDataStore;
const renderManagedSkills = (): Promise<string> => (store as any).renderManagedSkills();
const readCache = async () => JSON.parse(await readFile(join(root, "data/managed-skills/cache.json"), "utf8"));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "managed-skills-"));
  store = new AgentDataStore({} as never, { root: join(root, "data"), workspaceRoot: join(root, "workspace") });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("every skill has frontmatter naming its unique id and a description", () => {
  expect(new Set(managed.skills.map((s) => s.id)).size).toBe(managed.skills.length);
  for (const item of managed.skills) {
    const front = yaml(item.content.split("---")[1]!);
    expect(front.name).toBe(item.id);
    expect(front.description.trim().length).toBeGreaterThan(10);
  }
});

test("every tool a managed skill names exists under that name", async () => {
  const plugins = join(import.meta.dir, "../../plugins");
  const connectorTools = new Set<string>();
  for (const file of ["calendar", "docs", "drive", "drive-files", "gmail", "sheets", "slides"])
    for (const tool of JSON.parse(await readFile(join(plugins, "_shared/reference", `${file}.json`), "utf8")) as { name: string }[]) connectorTools.add(tool.name);
  for (const file of ["gmail/connector/server.ts", "email/connector/server.ts"])
    for (const [, name] of (await readFile(join(plugins, file), "utf8")).matchAll(/(?:tool\('|name: ")(\w+)['"]/g)) connectorTools.add(name!);
  const tool = (name: string) => { try { return referenceTool(name); } catch { return undefined; } };
  const argumentNames = new Set(managed.skills.flatMap((s) => [...s.content.matchAll(/\b[A-Z][A-Za-z]+\b/g)].flatMap(([name]) => Object.keys(tool(name)?.inputSchema.properties ?? {}))));
  const words = new Set([
    "AgentMail", "ContentType", "DejaVu", "DevTools", "DoorDash", "GitHub", "GitLab", "LibreOffice", "LinkedIn", "OpenTable", "OpenTeam",
    "PagerDuty", "PartName", "PowerPoint", "PptxGenJS", "SaaS", "TheFork", "WhatsApp", "YouTube",
    // Prompt blocks, stock states and routine wake blocks, not tools.
    "user_info", "agent_skills", "automation_status", "in_stock", "out_of_stock", "made_to_order", "github_event", "linear_event", "microsoft_teams_message",
    "origin_event", "pagerduty_event", "sentry_event", "slack_message", "webhook_event", "email_received",
  ]);
  const unknown: string[] = [];
  for (const item of managed.skills) {
    const prose = item.content.replace(/```[\s\S]*?```/g, "");
    const names = [...prose.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)].map(([name]) => name).filter((name) => !/^[\dA-F]+$/.test(name));
    // office-pptx names python-pptx attributes, not tools.
    if (item.id !== "office-pptx") names.push(...[...prose.matchAll(/(?<![\w./-])[a-z]+(?:_[a-z]+)+(?![\w/-])/g)].map(([name]) => name));
    for (const name of new Set(names))
      if (!words.has(name) && !tool(name) && !connectorTools.has(name) && !argumentNames.has(name)) unknown.push(`${item.id}: ${name}`);
  }
  expect(unknown).toEqual([]);
});

test("the routines skill lists exactly the trigger shapes the UpdateRoutine parser accepts", () => {
  expect(skill("routines")).toContain(`Trigger shapes:\n${AUTOMATION_TRIGGER_SHAPE_LINES.join("\n")}\n`);
});

test("the group-chat-turns trigger names the tag a room turn starts with", () => {
  const turn = buildGroupTurnPrompt({ groupName: "Launch", targetId: "a", targetName: "A", members: [{ id: "a", name: "A" }, { id: "b", name: "B" }], messages: [{ sender: "user", content: "hi" }] });
  expect(turn.startsWith(description("group-chat-turns").match(/starts with a (\[[^"]*")/)![1]!)).toBe(true);
});

test("syncing materializes every skill and catalogs it by path, without injecting bodies", async () => {
  await store.syncPluginSkillCache([]);
  const cache = await readCache();
  expect(cache.skills).toHaveLength(managed.skills.length);
  const rendered = await renderManagedSkills();
  for (const item of managed.skills) {
    const entry = cache.skills.find((s: { id: string }) => s.id === item.id);
    expect(entry.content).toBeUndefined();
    expect(await readFile(entry.filePath, "utf8")).toBe(item.content);
    expect(rendered).toContain(`<agent_skill fullPath="${join(root, "data/managed-skills", item.id, "SKILL.md")}">`);
  }
});

test.each(["cached", "missing", "disabled"] as const)("retires cached skills with %s metadata without touching user or plugin skills", async (state) => {
  const data = join(root, "data");
  const previous = process.env.OPENTEAM_MANAGED_SKILLS;
  delete process.env.OPENTEAM_MANAGED_SKILLS;
  try {
    if (state === "cached") await store.syncPluginSkillCache([]);
    const retired = ["sign-in", "site-playbooks-airbnb", "removed-custom-workflow"];
    for (const id of retired) {
      await mkdir(join(data, "managed-skills", id), { recursive: true });
      await writeFile(join(data, "managed-skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: Retired workflow fixture\n---\nRetired.\n`);
    }
    const userOwned = [join(data, "workflows", "sign-in", "SKILL.md"), join(data, "plugins", "site-playbooks-custom", "SKILL.md")];
    for (const file of userOwned) {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "user-owned skill");
    }
    if (state === "disabled") process.env.OPENTEAM_MANAGED_SKILLS = "false";
    await store.syncPluginSkillCache([]);
    for (const id of retired) await expect(access(join(data, "managed-skills", id))).rejects.toThrow();
    for (const file of userOwned) expect(await readFile(file, "utf8")).toBe("user-owned skill");
    expect((await readCache()).skills.map((s: { id: string }) => s.id)).toEqual(state === "disabled" ? [] : managed.skills.map((s) => s.id));
    expect(await renderManagedSkills()).not.toContain("/sign-in/SKILL.md");
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_MANAGED_SKILLS;
    else process.env.OPENTEAM_MANAGED_SKILLS = previous;
  }
});

test("the catalog drops a missing skill file and renders nothing for a disabled cache", async () => {
  await store.ensureRuntimeDirectories();
  const routines = `<agent_skill fullPath="${join(root, "data/managed-skills/routines/SKILL.md")}">`;
  expect(await renderManagedSkills()).toContain(routines);
  await rm(join(root, "data/managed-skills/routines/SKILL.md"));
  expect(await renderManagedSkills()).not.toContain(routines);
  await chmod(join(root, "data/managed-skills/cache.json"), 0o644);
  await writeFile(join(root, "data/managed-skills/cache.json"), '{"version":"disabled","skills":[]}');
  expect(await renderManagedSkills()).toBe("");
});

test("skills scoped to knowledgeWork reach only its worker catalog, alongside main's", async () => {
  await store.syncPluginSkillCache([]);
  const cached: { id: string; agents?: string[]; filePath: string }[] = (await readCache()).skills;
  const record = (id: string) => cached.find((s) => s.id === id);
  expect(record("slides-executor")!.agents).toEqual(["knowledgeWork"]);
  expect(record("slides")!.agents).toBeUndefined();
  const main = await renderManagedSkills();
  for (const id of ["slides", "slides-executor", "office-pptx"]) expect(main).toContain(`<agent_skill fullPath="${record(id)!.filePath}">`);
  const worker = await store.renderWorkerSkillCatalog("knowledgeWork");
  expect(worker).toStartWith("<agent_skills>");
  expect(worker).toContain(record("slides-executor")!.filePath);
  expect(worker).toContain(record("office-pptx")!.filePath);
  expect(worker).not.toContain(record("slides")!.filePath);
  expect(await store.renderWorkerSkillCatalog("executor")).toBe("");
});

test("the read-mode catalog shortens, then drops descriptions, then omits skills to fit its budget", () => {
  const long = "Use this when the user asks about the topic in question; it covers setup, the main workflow, the common pitfalls and the final checks you run before you reply. ".repeat(2);
  const skills = (count: number, dir = "/home/box/agent-data/managed-skills") =>
    Array.from({ length: count }, (_, i) => ({ fullPath: `${dir}/skill-${String(i).padStart(3, "0")}/SKILL.md`, description: long }));
  expect(renderSkillCatalog([])).toBe("");
  expect(agentSkillItem('/a/q"s/SKILL.md', "  a  b\n c ")).toBe('<agent_skill fullPath="/a/q&quot;s/SKILL.md">a b\n c</agent_skill>');
  expect(agentSkillItem("/a/s/SKILL.md", " ")).toBe('<agent_skill fullPath="/a/s/SKILL.md" />');
  expect(renderSkillCatalog(skills(12), 30_000)).toContain('<agent_skill fullPath="/home/box/agent-data/managed-skills/skill-011/SKILL.md">Use this when the user asks about the topic...</agent_skill>');
  // The purchases skill keeps its full description when others are cut.
  const protectedKept = renderSkillCatalog([...skills(12), { fullPath: "/home/box/agent-data/managed-skills/purchases/SKILL.md", description: long }], 30_000);
  expect(protectedKept).toContain('<agent_skill fullPath="/home/box/agent-data/managed-skills/skill-011/SKILL.md" />');
  expect(protectedKept).toContain(`<agent_skill fullPath="/home/box/agent-data/managed-skills/purchases/SKILL.md">${long.trim()}</agent_skill>`);
  const omitted = renderSkillCatalog([...skills(20), ...skills(20, "/home/box/agent-data/workflows")], 40_000);
  expect(omitted).toEndWith(
    `<agent_skill fullPath="/home/box/agent-data/workflows/skill-004/SKILL.md" />\n\n${omittedSkillsNotice(15, [5, 6, 7, 8, 9].map((i) => `/home/box/agent-data/workflows/skill-00${i}`))}\n</available_skills>\n</agent_skills>`
  );
  expect(renderSkillCatalog(skills(40), 10_000)).toContain("No skills are listed below, but additional skills may exist");
});
