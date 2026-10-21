import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerRuntime } from "../../src/runtime";
import { SKILL_TOOL_DESCRIPTION } from "@openteam/contracts/skill-tool";
import { agentSkills, loadOrSearchSkill, SKILL_TOOL_NAME, skillTool } from "../../src/runtime/skill-tool";

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

test("the Skill tool takes a name or a query and keeps its catalog out of its description", () => {
  const skills = agentSkills("knowledgeWork", root);
  expect(skills.map((skill) => skill.name)).toEqual(["slides-executor", "office-pptx"]);
  expect(agentSkills("executor", root)).toEqual([]);
  const tool = skillTool("knowledgeWork") as unknown as { description: string; parameters: { properties: Record<string, { description: string }>; required?: string[] } };
  expect(tool.description).toBe(SKILL_TOOL_DESCRIPTION);
  expect(tool.description).not.toContain("slides-executor");
  expect(Object.keys(tool.parameters.properties)).toEqual(["name", "query"]);
  expect(tool.parameters.required ?? []).toEqual([]);
  expect(tool.parameters.properties.name!.description).toEndWith("A name no skill has returns the closest matches instead.");
});

test("loading a skill returns its body in skill_content and says whether there is more to read", async () => {
  const skills = agentSkills("knowledgeWork", root);
  expect(await loadOrSearchSkill(skills, { name: "slides-executor" })).toBe(
    [
      '<skill_content name="slides-executor">',
      "# Slides executor\n\nBuild the deck.",
      "",
      "(This is the whole SKILL.md minus its frontmatter, and the skill has no helper files. There is nothing more to read.)",
      "</skill_content>",
    ].join("\n")
  );
  expect(await loadOrSearchSkill(skills, { name: " office-pptx " })).toBe(
    [
      '<skill_content name="office-pptx">',
      "# PPTX\n\nMake and check decks.",
      "",
      "(This is the whole SKILL.md minus its frontmatter. Reading the file would show nothing more.)",
      "",
      `Skill directory: ${join(root, "managed-skills", "office-pptx")}`,
      "Relative paths in this skill are relative to the skill directory.",
      "",
      "<skill_resources>",
      "  <file>scripts/grid.py</file>",
      "</skill_resources>",
      "</skill_content>",
    ].join("\n")
  );
  expect(await loadOrSearchSkill(skills, { name: skills[0]!.filePath })).toContain("# Slides executor");
  expect(await loadOrSearchSkill(skills, { name: "Office PPTX" })).toContain('<skill_content name="office-pptx">');
});

test("an unknown name or a query returns the closest skills, and a miss says what to do", async () => {
  const skills = agentSkills("knowledgeWork", root);
  expect(await loadOrSearchSkill(skills, { name: "slides" })).toBe(
    [
      '<skill_search query="slides">',
      'No skill named "slides". Closest matches:',
      "- slides-executor: For any slide deck task, read this first.",
      "Call Skill with one of these names to load it.",
      "</skill_search>",
    ].join("\n")
  );
  expect(await loadOrSearchSkill(skills, { query: "make a pptx deck" })).toStartWith('<skill_search query="make a pptx deck">\n- office-pptx:');
  expect(await loadOrSearchSkill(skills, { query: "weather" })).toBe(
    '<skill_search query="weather">\nNo skill matches this query. Search again with other words, or go on without a skill.\n</skill_search>'
  );
  expect(await loadOrSearchSkill(skills, { name: "weather" })).toContain(
    'No skill named "weather", and no skill is a close match. Call Skill with query, in words that describe the task, or go on without a skill.'
  );
  expect(await loadOrSearchSkill([], { name: "weather" })).toContain('No skill named "weather". You have no skills to load.');
  await expect(loadOrSearchSkill(skills, {})).rejects.toThrow("Pass name to load a skill, or query to search your skills.");
});

test("a name two skills share is refused with their paths", async () => {
  const skills = agentSkills("knowledgeWork", root);
  const twin = { ...skills[0]!, filePath: join(root, "other", "slides-executor", "SKILL.md") };
  await expect(loadOrSearchSkill([...skills, twin], { name: "slides-executor" })).rejects.toThrow(
    `More than one skill matches "slides-executor". Call Skill again with the one you mean, by its catalog path: ${skills[0]!.filePath}, ${twin.filePath}.`
  );
  await expect(loadOrSearchSkill([{ ...skills[0]!, filePath: join(root, "gone", "SKILL.md") }], { name: "gone" })).rejects.toThrow(
    `The skill "gone" is in your catalog but its SKILL.md is missing at ${join(root, "gone", "SKILL.md")}. The catalog may be out of date.`
  );
});
