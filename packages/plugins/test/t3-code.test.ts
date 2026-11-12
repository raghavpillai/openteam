import { expect, test } from "bun:test";
import { skillIsForAgent, substituteConfiguration, validateValues } from "@openteam/plugin-sdk";
import { parseSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../src";

test("T3 ships portable skills and a per-account OAuth URL without adopting a client identity", () => {
  const plugin = pluginCatalog.find((p) => p.key === "t3-code")!;
  expect(plugin).toBeDefined();
  const restored = importPackageArchive(exportPackageArchive(plugin)).definition;
  expect(restored.components).toEqual(["mcp", "skills"]);
  expect(restored.skills.map((skill) => skill.name)).toEqual(["t3-code", "t3-threads", "t3-setup"]);
  for (const skill of restored.skills) {
    expect(skill.body).toBeTruthy();
    expect(parseSkillMarkdown(restored.files![`${skill.path}/SKILL.md`]!, skill.name).name).toBe(
      skill.name
    );
    expect(skillIsForAgent(skill, "executor")).toBe(skill.name !== "t3-setup");
  }
  const connector = restored.connections[0]!;
  expect(connector).toMatchObject({
    transport: "http",
    auth: "oauth",
    oauth: {
      registration: "dynamic",
      clientType: "public",
      tokenEndpointAuthMethod: "none",
      shareClientCredentials: false,
    },
  });
  expect(connector.configuration).not.toHaveProperty("clientId");
  const first = validateValues(restored.setup!.fields, { mcpUrl: "https://first.example/mcp" });
  const second = validateValues(restored.setup!.fields, { mcpUrl: "https://second.example/mcp" });
  expect(substituteConfiguration(connector.endpoint, first)).toBe("https://first.example/mcp");
  expect(substituteConfiguration(connector.endpoint, second)).toBe("https://second.example/mcp");
});
