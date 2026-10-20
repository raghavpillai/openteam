import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "../src/agent-data";
import {
  pluginSkillsForAgent,
  renderPluginSkillCatalog,
  type PluginSkillCache,
} from "../src/plugin-skill-catalog";

const updatedAt = new Date("2026-10-14T12:00:00.000Z");
const manifest = {
  key: "fixture",
  name: "Fixture",
  version: "1",
  publisher: "OpenTeam",
  files: { "skills/main-only/reference.md": "Reference notes." },
  skills: [
    { name: "main-only", description: "Main", body: "Main agent workflow.", path: "skills/main-only" },
    {
      name: "sign-in",
      description: "Sign in",
      body: "Shared sign-in workflow.",
      path: "skills/sign-in",
      agents: ["main", "computerUse"],
    },
    { name: "desktop-only", description: "Desktop", body: "Desktop workflow.", agents: ["computerUse"] },
  ],
};
const installation = { name: "Fixture", pluginKey: "fixture", version: "1", manifest };
const privateSkill = { id: "private", name: "Private", description: "Private", body: "Private workflow.", updatedAt };

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-skill-catalog-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// The same cache sync the plugin service runs for one package and one private skill.
const store = (prisma: unknown = {}) =>
  new AgentDataStore(prisma as never, { root, workspaceRoot: join(root, "workspace") });
const syncCache = async (): Promise<PluginSkillCache> => {
  await store().syncPluginSkillCache([
    {
      id: manifest.key,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      skills: manifest.skills,
      files: manifest.files,
    },
    {
      id: `private-${privateSkill.id}`,
      name: privateSkill.name,
      version: updatedAt.toISOString(),
      publisher: "Private",
      skills: [{ ...privateSkill, path: "skills/private" }],
      files: {},
    },
  ]);
  return JSON.parse(await readFile(join(root, "plugin-skills/cache.json"), "utf8"));
};

const catalogPath = (catalog: string, entry: string): string => {
  const match = catalog.match(new RegExp(`^- ${entry}\\n  Path: (.+/SKILL\\.md)$`, "m"));
  if (!match?.[1]) throw new Error(`Missing catalog entry: ${entry}\n${catalog}`);
  return match[1];
};

test("the main agent's catalog lists each plugin skill with the path of its SKILL.md", async () => {
  const cache = await syncCache();
  const catalog = renderPluginSkillCatalog(pluginSkillsForAgent(cache, [installation], [privateSkill], "main"));

  for (const body of ["Main agent workflow.", "Shared sign-in workflow.", "Private workflow."])
    expect(catalog).not.toContain(body);
  expect(catalog).not.toContain("desktop-only");
  const mainOnly = catalogPath(catalog, "main-only \\(plugin:fixture\\): Main");
  expect(await readFile(mainOnly, "utf8")).toContain("Main agent workflow.");
  expect(await readFile(join(mainOnly, "../reference.md"), "utf8")).toBe("Reference notes.");
  expect(await readFile(catalogPath(catalog, "sign-in \\(plugin:fixture\\): Sign in"), "utf8")).toContain(
    "Shared sign-in workflow."
  );
  expect(await readFile(catalogPath(catalog, "Private \\(private\\): Private"), "utf8")).toContain(
    "Private workflow."
  );
});

test("only the files of the installed package revision are listed", async () => {
  const cache = await syncCache();
  const changed = { ...installation, manifest: { ...manifest, files: { "skills/main-only/reference.md": "Newer notes." } } };
  const upgraded = { ...installation, version: "2", manifest: { ...manifest, version: "2" } };
  for (const candidate of [changed, upgraded]) {
    const entries = pluginSkillsForAgent(cache, [candidate], [], "main");
    expect(entries.map((entry) => entry.path)).toEqual([undefined, undefined]);
    expect(renderPluginSkillCatalog(entries)).toBe("");
  }
  const editedPrivate = { ...privateSkill, updatedAt: new Date("2026-10-15T00:00:00.000Z") };
  expect(pluginSkillsForAgent(cache, [], [editedPrivate], "main")[0]?.path).toBeUndefined();
});

test("subagents get only the skills that name them, and never private skills", async () => {
  const cache = await syncCache();
  expect(pluginSkillsForAgent(cache, [installation], [privateSkill], "executor")).toEqual([]);
  expect(
    pluginSkillsForAgent(cache, [installation], [privateSkill], "computerUse").map((entry) => entry.name)
  ).toEqual(["sign-in", "desktop-only"]);
});

test("the agent prompt's skill catalog includes installed plugin skills", async () => {
  await syncCache();
  const prisma = {
    pluginInstallation: { findMany: async () => [installation] },
    pluginPrivateSkill: { findMany: async () => [privateSkill] },
  };
  const rendered: string = await (store(prisma) as any).renderPluginSkills("bot");
  expect(rendered).toBe(
    renderPluginSkillCatalog(pluginSkillsForAgent(await syncCache(), [installation], [privateSkill], "main"))
  );
  expect(rendered).toContain("- main-only (plugin:fixture): Main\n  Path: ");

  await rm(join(root, "plugin-skills/cache.json"));
  expect(await (store(prisma) as any).renderPluginSkills("bot")).toBe("");
});
