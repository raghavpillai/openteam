import { expect, test } from "bun:test";
import { clonePluginDefinition, type PluginDefinition } from "../src";

const fixture = (): PluginDefinition => ({
  key: "copy-test", version: "1.0.0", name: "Copy test", description: "Fixture",
  publisher: "Example", category: "Test", featured: false,
  components: ["mcp"], skills: [],
  connections: [{ key: "api", name: "API", transport: "http", auth: "none",
    endpoint: "https://example.test/mcp", configuration: { headers: { Accept: "application/json" } }, tools: [] }],
  files: { "server.js": "export const value = 1;" },
  binaryFiles: { "model.bin": "AAECAw==" },
});

test("cloning isolates mutable metadata and file maps in both directions", () => {
  const source = fixture();
  const original = structuredClone(source);
  const result = clonePluginDefinition(source);
  expect(result).toStrictEqual(original);
  // Deliberately bypass the public readonly type to verify runtime isolation.
  (result.connections[0]!.configuration as Record<string, unknown>).headers = { Accept: "changed" };
  result.components.push("skills");
  result.files!["server.js"] = "changed";
  delete result.binaryFiles!["model.bin"];
  expect(source).toStrictEqual(original);
  const second = clonePluginDefinition(source);
  source.connections[0]!.name = "changed";
  source.files!["extra.txt"] = "new";
  expect(second).toStrictEqual(original);
});
