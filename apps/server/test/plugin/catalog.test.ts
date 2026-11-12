import { describe, expect, test } from "bun:test";
import { validatePluginCatalog } from "@openteam/plugin-sdk";
import { pluginCatalog } from "@openteam/plugins";
import { boundPluginResult } from "../../src/services/plugin-service";
import { PLUGIN_RESULT_TEXT_LIMIT } from "../../src/services/plugin/values";

describe("plugin catalog", () => {
  test("ships normalized, unique plugin and connector identifiers", () => {
    expect(() => validatePluginCatalog(pluginCatalog)).not.toThrow();
    expect(new Set(pluginCatalog.map((plugin) => plugin.key)).size).toBe(pluginCatalog.length);
  });

  test("provides a complete guided setup for every authenticated connector", () => {
    for (const plugin of pluginCatalog) {
      for (const connection of plugin.connections.filter(
        (candidate) => candidate.auth !== "none"
      )) {
        expect(plugin.setup?.connectionKey).toBe(connection.key);
        expect(plugin.setup?.title).toBeTruthy();
        expect(plugin.setup?.description).toBeTruthy();
        expect(plugin.setup?.steps.length).toBeGreaterThan(0);
        expect(plugin.setup?.documentationUrl).toStartWith("https://");
      }
    }
  });

  test("rejects duplicate connector identities", () => {
    const source = pluginCatalog.find((plugin) => plugin.connections.length > 0);
    const connector = source?.connections[0];
    if (!source || !connector) throw new Error("Expected the bundled fixture connector");
    expect(() =>
      validatePluginCatalog([
        {
          ...source,
          connections: [connector, connector],
        },
      ])
    ).toThrow("Duplicate connector key");
  });

  test("bounds large and deeply nested tool results", () => {
    let nested: unknown = "hidden";
    for (let depth = 0; depth < 10; depth += 1) nested = { next: nested };
    const result = boundPluginResult({
      rows: Array.from({ length: 120 }, (_, index) => index),
      nested,
      text: "x".repeat(PLUGIN_RESULT_TEXT_LIMIT + 10),
    }) as { text: string; rows: unknown[]; nested: unknown };
    expect(result.text).toEndWith("[truncated]");
    expect(result.rows).toHaveLength(101);
    expect(JSON.stringify(result.nested)).toContain("nested value omitted");
  });

  test("keeps MCP image content intact instead of truncating its base64", () => {
    const data = "A".repeat(300_000);
    const result = boundPluginResult({
      content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: "x".repeat(100_010) }],
    }) as { content: Array<Record<string, string>> };
    expect(result.content[0]).toEqual({ type: "image", data, mimeType: "image/png" });
    // A long thread stays whole; the computer spills it to a file rather than the context.
    expect(result.content[1]!.text).toBe("x".repeat(100_010));
    const huge = boundPluginResult({ content: [{ type: "image", data: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" }] }) as { content: Array<Record<string, string>> };
    expect(huge.content[0]).toEqual({ type: "text", text: expect.stringContaining("image omitted") });
  });
});
