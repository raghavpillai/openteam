import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "@openteam/messaging";
import { pluginRuntimeContext, pluginSkillInstructions } from "../src/plugins";

const updatedAt = new Date("2026-10-14T12:00:00.000Z");
const manifest = {
  key: "fixture",
  name: "Fixture",
  version: "1",
  publisher: "OpenTeam",
  files: {},
  skills: [
    { name: "main-only", description: "Main", body: "Main agent workflow.", path: "skills/main-only" },
    {
      name: "sign-in",
      description: "Sign in",
      body: "Shared sign-in workflow.",
      path: "skills/sign-in",
      agents: ["main", "computerUse"],
    },
  ],
};
const installation = { name: "Fixture", pluginKey: "fixture", version: "1", status: "installed", manifest };
const privateSkill = { id: "private", name: "Private", description: "Private", body: "Private workflow.", updatedAt };
const prisma = {
  pluginConnection: { findMany: async () => [] },
  pluginInstallation: { findMany: async () => [installation] },
  pluginPrivateSkill: { findMany: async () => [privateSkill] },
} as any;

let root = "";
const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-worker-skills-"));
  process.env.OPENTEAM_AGENT_DATA_ROOT = root;
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
  else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

const syncCache = () =>
  new AgentDataStore({} as never, { root, workspaceRoot: join(root, "workspace") }).syncPluginSkillCache([
    { id: "fixture", name: "Fixture", version: "1", publisher: "OpenTeam", skills: manifest.skills, files: manifest.files },
    {
      id: "private-private",
      name: "Private",
      version: updatedAt.toISOString(),
      publisher: "Private",
      skills: [{ ...privateSkill, path: "skills/private" }],
      files: {},
    },
  ]);

test("cataloged plugin skills leave only provider-workflow notes in the main agent's instructions", async () => {
  await syncCache();
  const main = (await pluginRuntimeContext(prisma, "bot", "main")).skillInstructions;
  expect(main).toContain("## Installed plugin skills");
  expect(main).toContain("listed with their SKILL.md paths in the agent_skills catalog");
  for (const text of ["Main agent workflow.", "Shared sign-in workflow.", "Private workflow.", "Path:"])
    expect(main).not.toContain(text);
});

test("agents a skill names keep its full text, and executors get no skills", async () => {
  await syncCache();
  const worker = await pluginSkillInstructions(prisma, "child", "computerUse");
  expect(worker).toContain("Shared sign-in workflow.");
  expect(worker).not.toContain("Main agent workflow.");
  expect(worker).not.toContain("Private workflow.");
  expect((await pluginRuntimeContext(prisma, "parent", "executor")).skillInstructions).toBe("");
});

test("skills whose files are not on the computer yet keep their full text", async () => {
  const main = (await pluginRuntimeContext(prisma, "bot", "main")).skillInstructions;
  expect(main).toContain("Main agent workflow.");
  expect(main).toContain("Private workflow.");
  expect(main).not.toContain("agent_skills catalog");
});
