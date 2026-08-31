import { describe, expect, test } from "bun:test";
import {
  pluginSkillPromptForRuntime,
  subagentLoadsPluginContext,
  subagentRuntimeOwners,
} from "../src/worker";

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

  test("graphical workers never receive plugin tools or plugin skills", () => {
    expect(subagentLoadsPluginContext("computerUse")).toBe(false);
    expect(subagentLoadsPluginContext("browserUse")).toBe(false);
    expect(subagentLoadsPluginContext("executor")).toBe(true);
    expect(subagentLoadsPluginContext(null)).toBe(true);
  });

  test("no subagent inherits parent plugin skill prompt text", () => {
    expect(pluginSkillPromptForRuntime("subagent", "Parent plugin skill")).toBe("");
    expect(pluginSkillPromptForRuntime("agent", "Parent plugin skill")).toBe("Parent plugin skill");
  });

  test("ordinary agents own their own runtime resources", () => {
    expect(subagentRuntimeOwners("bot", null)).toEqual({
      screenBotId: "bot",
      pluginBotId: "bot",
    });
  });
});
