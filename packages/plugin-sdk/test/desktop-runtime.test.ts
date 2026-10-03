import { expect, test } from "bun:test";
import { assertComputerMcpRuntime, parsePluginDefinition } from "../src";
import { createPluginTemplate } from "../src/templates";

test("packaged MCP configurations require the computer runtime", () => {
  expect(() => assertComputerMcpRuntime({ command: "bun" })).not.toThrow();
  expect(() => assertComputerMcpRuntime({ runtime: "computer", command: "bun" })).not.toThrow();
  const configuration = { runtime: "desktop", provider: "1password", command: "1password-mcp" };
  expect(() => assertComputerMcpRuntime(configuration)).toThrow("Unsupported");
  expect(() => assertComputerMcpRuntime({ runtime: "unknown" })).toThrow("Unsupported");
  const plugin = createPluginTemplate("packaged-mcp", "desktop-test");
  plugin.connections[0]!.configuration = configuration;
  expect(() => parsePluginDefinition(plugin)).toThrow("Unsupported");
});
