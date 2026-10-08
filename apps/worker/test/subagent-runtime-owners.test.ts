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
        agents: ["main", "browserUse", "computerUse"],
      },
    ],
  },
};
const prisma = {
  pluginConnection: { findMany: async () => [] },
  pluginInstallation: { findMany: async () => [installation] },
  pluginPrivateSkill: {
    findMany: async () => [{ id: "private", name: "Private", description: "Private", body: "Private workflow." }],
  },
} as any;

describe("subagent runtime ownership", () => {
  test("computer and browser workers drive the parent desktop", () => {
    for (const subagentType of ["computerUse", "browserUse"]) {
      expect(subagentRuntimeOwners("child", { parentBotId: "parent", subagentType })).toMatchObject(
        { screenBotId: "parent" }
      );
    }
  });

  test("executor workers inherit parent plugin tools without sharing its screen", () => {
    expect(
      subagentRuntimeOwners("child", { parentBotId: "parent", subagentType: "executor" })
    ).toEqual({ screenBotId: "child", pluginBotId: "parent" });
  });

  test("graphical workers never receive plugin tools or runtime packages", () => {
    expect(subagentLoadsPluginContext("computerUse")).toBe(false);
    expect(subagentLoadsPluginContext("browserUse")).toBe(false);
    expect(subagentLoadsPluginContext("executor")).toBe(true);
    expect(subagentLoadsPluginContext(null)).toBe(true);
  });

  test("each agent receives the full text of the plugin skills declared for it", async () => {
    expect(pluginSkillAgent("agent", null)).toBe("main");
    expect(pluginSkillAgent("subagent", "browserUse")).toBe("browserUse");
    expect(pluginSkillAgent("subagent", null)).toBeNull();

    const main = (await pluginRuntimeContext(prisma, "bot", "main")).skillInstructions;
    expect(main).toContain("Main agent workflow.");
    expect(main).toContain("Shared sign-in workflow.");
    expect(main).toContain("Private workflow.");

    for (const agent of ["browserUse", "computerUse"] as const) {
      const worker = await pluginSkillInstructions(prisma, "child", agent);
      expect(worker).toContain("## Installed plugin skills");
      expect(worker).toContain("Shared sign-in workflow.");
      expect(worker).not.toContain("Main agent workflow.");
      expect(worker).not.toContain("Private workflow.");
    }

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
