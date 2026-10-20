import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerRuntime } from "../../src/runtime";
import { agentSkills, loadSkill, SKILL_TOOL_NAME, skillToolDescription } from "../../src/runtime/skill-tool";

let root = "";
const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;

const writeSkill = async (id: string, description: string, body: string, agents?: string[]) => {
  const filePath = join(root, "managed-skills", id, "SKILL.md");
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `---\nname: ${id}\ndescription: >-\n  ${description}\n---\n${body}`);
  return { id, name: id, description, filePath, ...(agents ? { agents } : {}) };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-skill-tool-"));
  process.env.OPENTEAM_AGENT_DATA_ROOT = root;
  const records = [
    await writeSkill("slides", "Before any deck work, read this.", "# Slides\n\nMain agent playbook.\n"),
    await writeSkill("slides-executor", "For any slide deck task, read this first.", "# Slides executor\n\nBuild the deck.\n", ["knowledgeWork"]),
    await writeSkill("office-pptx", "Use this skill any time a .pptx file is involved.", "# PPTX\n\nMake and check decks.\n", ["knowledgeWork"]),
  ];
  await mkdir(join(root, "managed-skills", "office-pptx", "scripts"), { recursive: true });
  await writeFile(join(root, "managed-skills", "office-pptx", "scripts", "grid.py"), "print('grid')\n");
  await writeFile(join(root, "managed-skills", "cache.json"), JSON.stringify({ version: "test", skills: records }));
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
  else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

const toolNames = (subagentType: string | null, skillAccess: "read" | "tool" = "tool") =>
  ((new ComputerRuntime() as unknown as { tools: any }).tools.customTools({ subagentType, skillAccess, runtimeProfile: subagentType ? "subagent" : "agent", pluginNamespaces: [] }) as Array<{ name: string }>).map(
    (tool) => tool.name
  );

test("with tool access, only the knowledgeWork worker gets the Skill tool, on top of the executor's tools", () => {
  const knowledgeWork = toolNames("knowledgeWork");
  expect(knowledgeWork).toEqual([...toolNames("executor"), SKILL_TOOL_NAME]);
  expect(toolNames("knowledgeWork", "read")).toEqual(toolNames("executor"));
  for (const type of [null, "executor", "computerUse"]) expect(toolNames(type)).not.toContain(SKILL_TOOL_NAME);
});

test("the Skill tool lists only the skills cataloged for its worker", () => {
  const skills = agentSkills("knowledgeWork", root);
  expect(skills.map((skill) => skill.name)).toEqual(["slides-executor", "office-pptx"]);
  const description = skillToolDescription(skills);
  expect(description).toStartWith("Load one of your skills by name and get its instructions.");
  expect(description).toContain("When a skill below fits the task, load it before acting on the task; do not just mention it.");
  expect(description).toContain("- slides-executor: For any slide deck task, read this first.");
  expect(description).toContain("- office-pptx: Use this skill any time a .pptx file is involved.");
  expect(description).not.toContain("- slides:");
  expect(agentSkills("executor", root)).toEqual([]);
});

test("loading a skill returns its body without frontmatter and names any helper files", async () => {
  const skills = agentSkills("knowledgeWork", root);
  expect(await loadSkill(skills, "slides-executor")).toBe(
    "# Slides executor\n\nBuild the deck.\n\nThere is nothing more to read."
  );
  const pptx = await loadSkill(skills, " office-pptx ");
  expect(pptx).toStartWith("# PPTX\n\nMake and check decks.\n\nSkill directory: ");
  expect(pptx).toEndWith("Helper files: scripts/grid.py");
  expect(await loadSkill(skills, skills[0]!.filePath)).toContain("# Slides executor");
});

test("unknown and ambiguous names are refused with the names to use", async () => {
  const skills = agentSkills("knowledgeWork", root);
  await expect(loadSkill(skills, "slides")).rejects.toThrow('No skill named "slides". Your skills: slides-executor, office-pptx.');
  const twin = { ...skills[0]!, filePath: join(root, "other", "SKILL.md") };
  const duplicated = [...skills, twin];
  expect(skillToolDescription(duplicated)).toContain(`- ${twin.filePath}: `);
  await expect(loadSkill(duplicated, "slides-executor")).rejects.toThrow("More than one skill is named");
});
