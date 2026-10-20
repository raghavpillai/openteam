import { expect, test } from "bun:test";
import { clonePluginDefinition, parsePluginDefinition, type PluginDefinition } from "../src";

const fixture = (): PluginDefinition => ({
  key: "copy-test", version: "1.0.0", name: "Copy test", description: "Fixture",
  publisher: "Example", category: "Test", featured: false,
  components: ["mcp"], skills: [],
  connections: [{ key: "api", name: "API", transport: "http", auth: "none",
    endpoint: "https://example.test/mcp", configuration: { headers: { Accept: "application/json" } }, tools: [] }],
  files: { "server.js": "export const value = 1;" },
  binaryFiles: { "model.bin": "AAECAw==" },
});

for (const [name, copy] of [["clone", clonePluginDefinition], ["parse", parsePluginDefinition]] as const) {
  test(`${name} isolates mutable metadata and file maps in both directions`, () => {
    const source = fixture();
    const original = structuredClone(source);
    const result = copy(source);
    expect(result).toStrictEqual(original);
    // Deliberately bypass the public readonly type to verify runtime isolation.
    (result.connections[0]!.configuration as Record<string, unknown>).headers = { Accept: "changed" };
    result.components.push("skills");
    result.files!["server.js"] = "changed";
    delete result.binaryFiles!["model.bin"];
    expect(source).toStrictEqual(original);
    const second = copy(source);
    source.connections[0]!.name = "changed";
    source.files!["extra.txt"] = "new";
    expect(second).toStrictEqual(original);
  });

  test(`${name} preserves absent versus explicitly undefined payload fields`, () => {
    const source = fixture();
    delete source.files;
    source.binaryFiles = undefined;
    const result = copy(source);
    expect(Object.hasOwn(result, "files")).toBe(false);
    expect(Object.hasOwn(result, "binaryFiles")).toBe(true);
    expect(result.binaryFiles).toBeUndefined();
  });
}

test("parsing still rejects invalid payloads before copying", () => {
  const source = fixture();
  source.binaryFiles!["model.bin"] = "invalid base64";
  expect(() => parsePluginDefinition(source)).toThrow("Invalid binary file encoding");
  source.binaryFiles = { "../escape": "AA==" };
  expect(() => parsePluginDefinition(source)).toThrow("Unsafe package path");
});
