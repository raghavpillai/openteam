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
    expect(catalog).toContain(`<agent_skill fullPath="${record("slides").filePath}">`);
    expect(catalog).not.toContain(record("slides-executor").filePath);
    expect(catalog).not.toContain(record("office-pptx").filePath);
    // The knowledgeWork worker loads its own skills with the Skill tool, so its agent_skills block lists them by name.
    const description = (id: string) => record(id).description.replace(/\s+/g, " ").trim();
    expect(await store.renderWorkerSkillCatalog("knowledgeWork")).toBe(
      [
        "<agent_skills>",
        "When a skill below fits the task, load it with Skill before acting on the task; do not just mention it.",
        "",
        "Your skills, one per line as name: when to use it. A skill that shares its name with another is listed by its path.",
        `- slides-executor: ${description("slides-executor")}`,
        `- office-pptx: ${description("office-pptx")}`,
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

test("the knowledgeWork worker loads its skills with the Skill tool; no other worker has skills", () => {
  expect(workerSkillAccess("knowledgeWork")).toBe("tool");
  for (const type of ["executor", "computerUse", "videoReview", null]) expect(workerSkillAccess(type)).toBe("read");
  for (const type of ["knowledgeWork", "executor"] as const) expect(subagentSpecializationInstructions(type)).not.toContain("skill");
});
