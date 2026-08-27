import { describe, expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@openbot/contracts";
import { BROWSER_USE_TOOLS } from "../src/browser-use";
import { ComputerRuntime } from "../src/runtime";

const toolNames = (subagentType: "computerUse" | "browserUse" | "executor" | null) => {
  const runtime = new ComputerRuntime() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{ name: string }>;
  };
  return runtime.customTools({ subagentType }).map((tool) => tool.name);
};

const dynamicToolNames = (namespace: string) => {
  const runtime = new ComputerRuntime() as unknown as {
    dynamicCatalog(active: {
      runtimeProfile: "agent";
      pluginNamespaces: [];
    }): Array<{ name: string; tools: Array<{ name: string }> }>;
  };
  return (
    runtime
      .dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((candidate) => candidate.name === namespace)
      ?.tools.map((tool) => tool.name) ?? []
  );
};

describe("specialized subagent tool surfaces", () => {
  test("computerUse receives only Shell, Read, and direct Computer", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "Computer"]);
  });

  test("browserUse receives only Shell, Read, and the direct browser tools", () => {
    expect(toolNames("browserUse")).toEqual([
      "Shell",
      "Read",
      ...BROWSER_USE_TOOLS.map((tool) => tool.name),
    ]);
  });

  test("normal agents retain the closed ten-tool native catalog", () => {
    expect(toolNames(null)).toEqual(NATIVE_TOOL_NAMES);
  });

  test("normal agents cannot discover legacy graphical Computer control", () => {
    expect(dynamicToolNames("openbot")).toEqual(["SendToAgent"]);
    expect(dynamicToolNames("cursor")).toContain("Task");
  });
});
