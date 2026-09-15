import { expect, test } from "bun:test";
import { desktopMcpProvider, parsePluginDefinition } from "../src";
import { createPluginTemplate } from "../src/templates";

const configuration = { runtime: "desktop", provider: "1password", command: "1password-mcp" };
test("desktop adapters reject launch overrides and unsupported provider modes", () => {
  expect(desktopMcpProvider(configuration)).toBe("1password");
  expect(desktopMcpProvider({ command: "bun" })).toBeNull();
  for (const change of [
    { runtime: "unknown" }, { command: "sh" }, { provider: "other" },
    { args: ["-c", "echo test"] }, { args: "bad" }, { cwd: "/tmp" },
    { env: { OP_SERVICE_ACCOUNT_TOKEN: "must-not-forward" } },
  ]) expect(() => desktopMcpProvider({ ...configuration, ...change })).toThrow();
  const plugin = createPluginTemplate("packaged-mcp", "desktop-test");
  plugin.connections[0]!.configuration = configuration;
  expect(parsePluginDefinition(plugin).connections[0]!.configuration).toEqual(configuration);
  plugin.connections[0]!.auth = "token";
  expect(() => parsePluginDefinition(plugin)).toThrow("authenticate in their desktop app");
});
