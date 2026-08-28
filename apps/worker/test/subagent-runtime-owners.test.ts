import { describe, expect, test } from "bun:test";
import {
  subagentCompletionEnvelope,
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

  test("executor workers inherit the parent plugin catalog without sharing its screen", () => {
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

  test("ordinary agents own their own runtime resources", () => {
    expect(subagentRuntimeOwners("bot", null)).toEqual({
      screenBotId: "bot",
      pluginBotId: "bot",
    });
  });

  test("tells the parent that completion content is still private", () => {
    const envelope = subagentCompletionEnvelope(
      "<user_visible_high_level_summary>Ready to ship.</user_visible_high_level_summary>\n<response>All checks passed, including the private audit.</response>"
    );
    expect(envelope).toContain("no Task card or child result has been added");
    expect(envelope).toContain("candidate text for a normal user-facing message");
    expect(envelope).toContain("stay quiet when the user explicitly asked");
    expect(envelope).not.toContain("already visible to the user");
    expect(envelope).toContain(
      "<user_visible_high_level_summary>\nReady to ship.\n</user_visible_high_level_summary>"
    );
    expect(envelope).toContain(
      "<response>\nAll checks passed, including the private audit.\n</response>"
    );
  });
});
