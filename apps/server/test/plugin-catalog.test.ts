import { describe, expect, test } from "bun:test";
import { pluginCatalog, validatePluginCatalog } from "../src/plugins/catalog";
import { boundPluginResult } from "../src/services/plugin-service";

describe("plugin catalog", () => {
  test("ships normalized, unique plugin and connector identifiers", () => {
    expect(() => validatePluginCatalog(pluginCatalog)).not.toThrow();
    expect(new Set(pluginCatalog.map((plugin) => plugin.key)).size).toBe(pluginCatalog.length);
  });

  test("fixture tools declare schemas and conservative write defaults", () => {
    const fixture = pluginCatalog.find((plugin) => plugin.key === "openbot-utility-lab");
    const connector = fixture?.connections[0];
    expect(connector?.transport).toBe("builtin");
    expect(connector?.tools.map((tool) => tool.name)).toEqual(["echo", "add", "remember_note"]);
    expect(connector?.tools.find((tool) => tool.name === "remember_note")?.defaultDecision).toBe(
      "prompt"
    );
  });

  test("rejects duplicate connector identities", () => {
    const source = pluginCatalog[0]!;
    expect(() =>
      validatePluginCatalog([
        {
          ...source,
          connections: [source.connections[0]!, source.connections[0]!],
        },
      ])
    ).toThrow("Duplicate connector key");
  });

  test("bounds large and deeply nested tool results", () => {
    let nested: unknown = "hidden";
    for (let depth = 0; depth < 10; depth += 1) nested = { next: nested };
    const result = boundPluginResult({
      text: "x".repeat(100_010),
      rows: Array.from({ length: 120 }, (_, index) => index),
      nested,
    }) as { text: string; rows: unknown[]; nested: unknown };
    expect(result.text).toEndWith("[truncated]");
    expect(result.rows).toHaveLength(101);
    expect(JSON.stringify(result.nested)).toContain("nested value omitted");
  });
});
