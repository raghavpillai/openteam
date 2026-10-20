import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import managed from "../src/prompts/managed-skills.json";
import { AgentDataStore } from "../src/agent-data";
import { subagentSpecializationInstructions, workerSkillAccess } from "../src/index";
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

test("knowledgeWork skills stay out of the main agent's catalog and workflow list", async () => {
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
    expect(catalog).toContain("managed:slides)");
    expect(catalog).not.toContain("managed:slides-executor");
    expect(catalog).not.toContain("managed:office-pptx");
    // The knowledgeWork worker gets its own skills as an agent_skills block with file paths.
    const description = (id: string) => record(id).description;
    expect(await store.renderWorkerSkillCatalog("knowledgeWork")).toBe(
      [
        "<agent_skills>",
        "When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge. To use a skill, read the skill file at the provided absolute path using the Read tool, then follow the instructions within. When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it. Only use skills listed below.",
        "",
        "",
        '<available_skills description="Skills the agent can use. Use the Read tool with the provided absolute path to fetch full contents.">',
        `<agent_skill fullPath="${record("slides-executor").filePath}">${description("slides-executor")}</agent_skill>`,
        "",
        `<agent_skill fullPath="${record("office-pptx").filePath}">${description("office-pptx")}</agent_skill>`,
        "</available_skills>",
        "</agent_skills>",
      ].join("\n")
    );
    expect(await store.renderWorkerSkillCatalog("executor")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const workflows = renderPlatformBaseSystemPrompt().match(/## Managed workflows\n[^\n]*/)?.[0] ?? "";
  expect(workflows).toContain("slides");
  expect(workflows).not.toContain("slides-executor");
  expect(workflows).not.toContain("office-pptx");
});

test("the knowledgeWork worker reads its own skills from its agent_skills section", () => {
  const instructions = subagentSpecializationInstructions("knowledgeWork");
  expect(instructions).toContain("in the agent_skills section of the user_info block near the start of the conversation");
  expect(subagentSpecializationInstructions("executor")).not.toContain("agent_skills");
});

test("the skill tool switch is off by default and swaps the catalog for the Skill tool when on", async () => {
  const previous = process.env.OPENTEAM_SKILL_TOOL;
  try {
    delete process.env.OPENTEAM_SKILL_TOOL;
    expect(workerSkillAccess("knowledgeWork")).toBe("read");
    process.env.OPENTEAM_SKILL_TOOL = "true";
    expect(workerSkillAccess("knowledgeWork")).toBe("tool");
    expect(workerSkillAccess("executor")).toBe("read");
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_SKILL_TOOL;
    else process.env.OPENTEAM_SKILL_TOOL = previous;
  }
  const tool = subagentSpecializationInstructions("knowledgeWork", "tool");
  expect(tool).toContain("Your skills are cataloged (name plus a when-to-use description) in the description of the Skill tool.");
  expect(tool).toContain("Load a skill with the Skill tool instead of reading a SKILL.md with Read, even where other lines say to Read one.");
  expect(tool).not.toContain("agent_skills");
});
