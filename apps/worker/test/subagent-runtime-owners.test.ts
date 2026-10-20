import { describe, expect, test } from "bun:test";
import { pluginRuntimeContext, pluginSkillInstructions } from "../src/plugins";
import {
  pluginSkillAgent,
  subagentLoadsPluginContext,
  subagentRuntimeOwners,
} from "../src/worker";

const installation = {
  name: "Fixture",
  pluginKey: "fixture",
  version: "1",
  status: "installed",
  manifest: {
    files: {},
    skills: [
      { name: "main-only", description: "Main", body: "Main agent workflow." },
      {
        name: "sign-in",
        description: "Sign in",
        body: "Shared sign-in workflow.",
        agents: ["main", "computerUse"],
      },
    ],
  },
};
const prisma = {
  pluginConnection: { findMany: async () => [] },
  pluginInstallation: { findMany: async () => [installation] },
  pluginPrivateSkill: {
    findMany: async () => [
      { id: "private", name: "Private", description: "Private", body: "Private workflow.", updatedAt: new Date() },
    ],
  },
} as any;

describe("subagent runtime ownership", () => {
  test("the computerUse worker drives the parent desktop", () => {
    expect(
      subagentRuntimeOwners("child", { parentBotId: "parent", subagentType: "computerUse" })
    ).toMatchObject({ screenBotId: "parent" });
  });

  test("executor and knowledgeWork workers inherit parent plugin tools without sharing its screen", () => {
    for (const subagentType of ["executor", "knowledgeWork"]) {
      expect(subagentRuntimeOwners("child", { parentBotId: "parent", subagentType })).toEqual({
        screenBotId: "child",
        pluginBotId: "parent",
      });
    }
    expect(subagentLoadsPluginContext("knowledgeWork")).toBe(true);
  });

  test("graphical and media workers never receive plugin tools or runtime packages", () => {
    expect(subagentLoadsPluginContext("computerUse")).toBe(false);
    expect(subagentLoadsPluginContext("videoReview")).toBe(false);
    expect(subagentLoadsPluginContext("watchVideo")).toBe(false);
    expect(subagentLoadsPluginContext("executor")).toBe(true);
    expect(subagentLoadsPluginContext(null)).toBe(true);
  });

  test("each agent receives the full text of the plugin skills declared for it", async () => {
    expect(pluginSkillAgent("agent", null)).toBe("main");
    expect(pluginSkillAgent("subagent", "computerUse")).toBe("computerUse");
    expect(pluginSkillAgent("subagent", null)).toBeNull();

    const main = (await pluginRuntimeContext(prisma, "bot", "main")).skillInstructions;
    expect(main).toContain("Main agent workflow.");
    expect(main).toContain("Shared sign-in workflow.");
    expect(main).toContain("Private workflow.");

    const worker = await pluginSkillInstructions(prisma, "child", "computerUse");
    expect(worker).toContain("## Installed plugin skills");
    expect(worker).toContain("Shared sign-in workflow.");
    expect(worker).not.toContain("Main agent workflow.");
    expect(worker).not.toContain("Private workflow.");

    expect((await pluginRuntimeContext(prisma, "parent", "executor")).skillInstructions).toBe("");
    expect(await pluginSkillInstructions(prisma, "child", null)).toBe("");
  });

  test("ordinary agents own their own runtime resources", () => {
    expect(subagentRuntimeOwners("bot", null)).toEqual({
      screenBotId: "bot",
      pluginBotId: "bot",
    });
  });
});
