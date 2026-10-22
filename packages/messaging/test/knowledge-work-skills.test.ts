import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import managed from "../src/prompts/managed-skills.json";
import { AgentDataStore } from "../src/agent-data";
import { subagentSpecializationInstructions } from "../src/index";
import { agentSkillItem, omittedSkillsNotice, renderSkillCatalog } from "../src/skill-catalog";
import { renderPlatformBaseSystemPrompt } from "../src/platform-system-prompt";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const installed = (id: string) => managed.skills.find((skill) => skill.id === id) as
  | { id: string; content: string; agents?: string[] }
  | undefined;

test("new decks are written with PptxGenJS because the office toolkit ships without a template library", async () => {
  const sections = (text: string) => text.split(/^(?=#{2,} )/m).map((part) => [part.slice(0, part.indexOf("\n")), part] as const);
  for (const id of ["slides-executor", "office-pptx"]) {
    const copy = installed(id)!.content;
    expect(copy).toContain("PptxGenJS");
    expect(copy).not.toContain("search-templates");
  }
  const family = sections(installed("slides-executor")!.content).find(([heading]) => heading === "## The `family` phase")![1];
  expect(family).toContain("A family is a deck that you write with PptxGenJS.");
  // Box-only fonts do not survive a Google Slides import, so families name fonts the destination has.
  expect(family).toContain("Name fonts that the destination has.");
  expect(family).not.toContain("fc-list");

  const root = join(import.meta.dir, "../../../docker");
  const toolkit = JSON.parse(await readFile(join(root, "officekit-ts.sha256.json"), "utf8")) as { files: Record<string, string> };
  const shipped = (await readdir(join(root, "officekit-ts"), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(join(root, "officekit-ts"), join(entry.parentPath, entry.name)))
    .sort();
  expect(shipped).toEqual(Object.keys(toolkit.files).sort());
  expect(shipped.some((file) => file.startsWith("share/officekit/pptx/template"))).toBe(false);
  for (const file of shipped) expect(sha256(await readFile(join(root, "officekit-ts", file)))).toBe(toolkit.files[file]!);
});

test("a Google Slides deck lands in Drive once and is checked as Google draws it", async () => {
  const slides = installed("slides")!.content;
  expect(slides).toContain("**One file in their Drive.**");
  expect(slides).toContain("- the edit surface: the local `.pptx`, or the live deck through the Slides MCP");
  const executor = installed("slides-executor")!.content;
  expect(executor).toContain("## Edit through the Slides MCP");
  expect(executor).toContain("## A deck in Google Slides");
  // Only tools the Slides and Drive connectors here actually serve.
  const served = async (file: string) =>
    (JSON.parse(await readFile(join(import.meta.dir, "../../plugins/_shared/reference", file), "utf8")) as { name: string }[]).map((tool) => tool.name);
  const tools = [...(await served("slides.json")), ...(await served("drive-files.json"))];
  for (const name of executor.match(/`([a-z]+_[a-z_]+)`/g)!.map((quoted) => quoted.slice(1, -1)).filter((name) => !name.endsWith("_")))
    expect(tools).toContain(name);
  expect(executor).not.toMatch(/update_presentation|read_slide_page_thumbnail/);
});

test("the main agent's catalog and workflow list include the skills knowledgeWork carries", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-kw-skills-"));
  try {
    const store = new AgentDataStore({} as never, { root: join(root, "data"), workspaceRoot: join(root, "workspace") });
    await store.syncPluginSkillCache([]);
    const cache = JSON.parse(await readFile(join(root, "data/managed-skills/cache.json"), "utf8"));
    const record = (id: string) => cache.skills.find((skill: { id: string }) => skill.id === id);
    expect(record("slides-executor").agents).toEqual(["knowledgeWork"]);
    expect(record("office-pptx").agents).toEqual(["knowledgeWork"]);
    expect(record("slides").agents).toBeUndefined();
    const catalog: string = await (store as any).renderManagedSkills();
    expect(catalog).toContain(`<agent_skill fullPath="${record("slides").filePath}">`);
    expect(catalog).toContain(`<agent_skill fullPath="${record("slides-executor").filePath}">`);
    expect(catalog).toContain(`<agent_skill fullPath="${record("office-pptx").filePath}">`);
    // knowledgeWork has no Skill tool: like the main agent, its agent_skills block lists file paths to open with Read.
    const kwCatalog = await store.renderWorkerSkillCatalog("knowledgeWork");
    expect(kwCatalog).toBe(
      [
        "<agent_skills>",
        "When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge. To use a skill, read the skill file at the provided absolute path using the Read tool, then follow the instructions within. When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it. Only use skills listed below.",
        "",
        "",
        '<available_skills description="Skills the agent can use. Use the Read tool with the provided absolute path to fetch full contents.">',
        `<agent_skill fullPath="${record("slides-executor").filePath}">${record("slides-executor").description}</agent_skill>`,
        "",
        `<agent_skill fullPath="${record("office-pptx").filePath}">${record("office-pptx").description}</agent_skill>`,
        "</available_skills>",
        "</agent_skills>",
      ].join("\n")
    );
    expect(kwCatalog).not.toMatch(/\bSkill\b(?! tool)|load it with|with query/);
    expect(await store.renderWorkerSkillCatalog("executor")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const workflows = renderPlatformBaseSystemPrompt().match(/## Managed workflows\n[^\n]*/)?.[0] ?? "";
  expect(workflows).toContain("slides");
  expect(workflows).toContain("slides-executor");
  expect(workflows).toContain("office-pptx");
});

test("knowledgeWork's prompt names no Skill tool", () => {
  for (const type of ["knowledgeWork", "executor"] as const) expect(subagentSpecializationInstructions(type)).not.toContain("Skill");
});

// Expected texts rendered by the reference's own read-mode catalog builder (2026-10-21 build).
test("the read-mode catalog shortens, then drops descriptions, then omits skills as the reference's does", () => {
  const long = "Use this when the user asks about the topic in question; it covers setup, the main workflow, the common pitfalls and the final checks you run before you reply. ".repeat(2);
  const skills = (count: number, root = "/home/box/agent-data/managed-skills") =>
    Array.from({ length: count }, (_, i) => ({ fullPath: `${root}/skill-${String(i).padStart(3, "0")}/SKILL.md`, description: long }));
  expect(renderSkillCatalog([])).toBe("");
  expect(agentSkillItem("/a/q\"s/SKILL.md", "  a  b\n c ")).toBe('<agent_skill fullPath="/a/q&quot;s/SKILL.md">a b\n c</agent_skill>');
  expect(agentSkillItem("/a/s/SKILL.md", " ")).toBe('<agent_skill fullPath="/a/s/SKILL.md" />');
  const shortened = renderSkillCatalog(skills(12), 30_000);
  expect(shortened).toContain('<agent_skill fullPath="/home/box/agent-data/managed-skills/skill-011/SKILL.md">Use this when the user asks about the topic...</agent_skill>');
  expect(shortened).toContain("Only use skills listed below.");
  const protectedKept = renderSkillCatalog([...skills(12), { fullPath: "/home/box/agent-data/managed-skills/purchases/SKILL.md", description: long }], 30_000);
  expect(protectedKept).toContain('<agent_skill fullPath="/home/box/agent-data/managed-skills/skill-011/SKILL.md" />');
  expect(protectedKept).toContain(`<agent_skill fullPath="/home/box/agent-data/managed-skills/purchases/SKILL.md">${long.trim()}</agent_skill>`);
  const omitted = renderSkillCatalog([...skills(20), ...skills(20, "/home/box/agent-data/workflows")], 40_000);
  expect(omitted).toContain("Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section.");
  expect(omitted).toEndWith(
    `<agent_skill fullPath="/home/box/agent-data/workflows/skill-004/SKILL.md" />\n\n${omittedSkillsNotice(15, [5, 6, 7, 8, 9].map((i) => `/home/box/agent-data/workflows/skill-00${i}`))}\n</available_skills>\n</agent_skills>`
  );
  expect(renderSkillCatalog(skills(40), 10_000)).toContain("No skills are listed below, but additional skills may exist");
});
