import { expect, test } from "bun:test";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { parsePluginRuntimeComponents } from "@openteam/plugin-sdk";
import { pluginCatalog } from "../src";

test("Ramp exports the MCP connector and preserves bundled playbooks and references", () => {
  const ramp = pluginCatalog.find((plugin) => plugin.key === "ramp")!;
  const { definition, warnings } = importPackageArchive(exportPackageArchive(ramp));
  expect(warnings).toEqual([]);
  expect(definition.connections).toMatchObject([{
    transport: "http",
    auth: "oauth",
    endpoint: "https://mcp.ramp.com/mcp",
    oauth: { registration: "dynamic", clientType: "public", shareClientCredentials: false },
  }]);
  for (const skill of definition.skills)
    expect(definition.files?.[`${skill.path}/SKILL.md`]).toBe(ramp.files?.[`${skill.path}/SKILL.md`]);
  const reference = "upstream/plugins/ramp/skills/ramp-agentic-purchase/browser-checkout.md";
  expect(definition.files?.[reference]).toBe(ramp.files?.[reference]);
  expect(parsePluginRuntimeComponents(definition.files ?? {}).rules).toMatchObject([
    { name: "ramp-openteam", alwaysApply: true },
  ]);
});
