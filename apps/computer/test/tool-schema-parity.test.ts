import { describe, expect, test } from "bun:test";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import { referenceTool } from "@openteam/contracts/tool-contracts";
import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { taskToolContract } from "@openteam/contracts/tool-contracts";
import { enrichUserInfo } from "../src/runtime/prompt-context";
import { APP_SETTINGS_ANCHORS } from "@openteam/contracts/app-deep-links";
import { SETTINGS_ANCHORS } from "../../desktop/src/renderer/lib/app-deep-links";

// The baseline is extracted from the captured external tool catalog, not our handlers.
describe("captured tool contract wiring", () => {
  test("Task profiles and the graphical worker's tools agree with the advertised context", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    const taskConfiguration = { executorProfiles: [
      { name: "quick", description: "Small jobs", providerId: "openai", modelId: "fixture", reasoning: "low" as const },
    ] };
    const active = { runtimeProfile: "agent", pluginNamespaces: [], taskConfiguration } as unknown as ActiveTurn;
    const task = (runtime as any).dynamicCatalog(active).flatMap((namespace: any) => namespace.tools).find((tool: any) => tool.name === "Task");
    expect(task.inputSchema).toEqual(taskToolContract(taskConfiguration).inputSchema);
    const userInfo = enrichUserInfo("<user_info></user_info>", { cwd: "/tmp", catalog: null, taskConfiguration });
    expect(userInfo).toContain("computerUse: Delegate a self-contained browser or desktop task");
    // Worker inference is server-controlled; profiles are not model-selectable.
    expect(userInfo).not.toContain("quick: Small jobs");
    const computer = runtime.customTools({ ...active, runtimeProfile: "subagent", subagentType: "computerUse" });
    expect(computer.some(tool => tool.name === "browser_snapshot")).toBe(true);
    expect(computer.some(tool => tool.name === "Computer")).toBe(true);
    for (const subagentType of ["executor", "computerUse"] as const) {
      const worker = { ...active, runtimeProfile: "subagent" as const, subagentType };
      expect(runtime.customTools(worker).some(tool => tool.name === "Task")).toBe(false);
      expect((runtime as any).dynamicCatalog(worker).flatMap((namespace: any) => namespace.tools).some((tool: any) => tool.name === "Task")).toBe(false);
    }
  });

  test("SendToUser lists exactly the app's settings links and applies its advertised default type", () => {
    const actual = referenceTool("SendToUser");
    const anchors = /<anchor> one of: ([^.]+)\./.exec(actual.description)![1]!.split(", ");
    expect(anchors).toEqual([...APP_SETTINGS_ANCHORS]);
    expect(anchors).toEqual([...SETTINGS_ANCHORS]);
    expect(actual.inputSchema.required).toBeUndefined();
    expect(normalizeMainToolArguments("SendToUser", { content: "Hi" })).toMatchObject({ type: "text", content: "Hi" });
  });

  test("the advertised secret alternatives agree with the SendToUser parser", () => {
    const schema = Type.Unsafe<Record<string, unknown>>(referenceTool("SendToUser").inputSchema);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ label: "API token", name: "API_TOKEN" }, true],
      [{ label: "API token", name: "API_TOKEN", scope: "personal" }, true],
      [{ label: "API token", connector: "search", field: "apiKey" }, true],
      [{ label: "API token" }, false],
      [{ label: "API token", connector: "search" }, false],
      [{ label: "API token", field: "apiKey" }, false],
      [{ label: "API token", name: "API_TOKEN", connector: "search" }, false],
      [{ label: "API token", name: "API_TOKEN", field: "apiKey" }, false],
      [{ label: "API token", name: "API_TOKEN", connector: "search", field: "apiKey" }, false],
      [{ name: "API_TOKEN" }, false],
      [{ label: "API token", name: "API_TOKEN", scope: "unknown" }, false],
    ];
    for (const [secret, valid] of cases) {
      const input = { type: "secret-request", secret };
      expect(Value.Check(schema, input), JSON.stringify(secret)).toBe(valid);
      if (valid) expect(normalizeMainToolArguments("SendToUser", input)).toMatchObject(input);
      else expect(() => normalizeMainToolArguments("SendToUser", input)).toThrow();
    }
  });
});
