import { describe, expect, test } from "bun:test";
import { BROWSER_USE_TOOLS } from "../src/browser/use";
import { RuntimeTools } from "../src/runtime/tools";
import type { ActiveTurn } from "../src/runtime/types";
import { objectToolSchema } from "../src/tool-schema";
import reference from "../../../packages/contracts/src/tool-reference.json";
import { referenceTool } from "@openteam/contracts/tool-contracts";

// The baseline is extracted from the captured external tool catalog, not our handlers.
describe("captured tool contract wiring", () => {
  test("exposes all 74 shared contracts through the actual model-facing profiles", () => {
    const runtime = new RuntimeTools({} as never, "http://unused.invalid", "test", "/tmp", "/tmp");
    const base = { runtimeProfile: "agent", pluginNamespaces: [] } as unknown as ActiveTurn;
    const catalog = [
      base,
      { ...base, requestSource: "automation" },
      ...["browserUse", "computerUse"].map((subagentType) => ({
        ...base,
        runtimeProfile: "subagent",
        subagentType,
      })),
    ].flatMap((active) => [
      ...runtime
        .customTools(active as ActiveTurn)
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      ...(active.runtimeProfile === "agent"
        ? (runtime as any).dynamicCatalog(active).flatMap((n: any) => n.tools)
        : []),
    ]);
    expect(Object.keys(reference)).toHaveLength(74);
    for (const name of Object.keys(reference)) {
      const visible = catalog.find((t) => t.name === name);
      expect(visible, name).toBeDefined();
      expect(visible.description, name).toBe(referenceTool(name).description);
      expect(visible.inputSchema, name).toEqual(referenceTool(name).inputSchema);
    }
    for (const excluded of ["GenerateImage", "CloudAgent", "request_scm_connect"])
      expect(catalog.some((t) => t.name === excluded)).toBe(false);
  });

  test("preserves the captured graphical schemas including held clicks", () => {
    expect(BROWSER_USE_TOOLS).toHaveLength(15);
    for (const tool of BROWSER_USE_TOOLS) expect(tool).toEqual((reference as any)[tool.name]);
    expect(reference.browser_click.inputSchema.properties.holdDurationMs.maximum).toBe(30_000);
    expect(reference.browser_mouse_click_xy.inputSchema.properties.holdDurationMs.maximum).toBe(
      30_000
    );
  });

  test("distinguishes an omitted required list from an explicit empty list", () => {
    expect(objectToolSchema({})).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(objectToolSchema({}, [])).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
