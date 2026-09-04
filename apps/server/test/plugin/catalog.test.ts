import { describe, expect, test } from "bun:test";
import { pluginCatalog, validatePluginCatalog } from "../../src/plugins/catalog";
import { boundPluginResult } from "../../src/services/plugin-service";

describe("plugin catalog", () => {
  test("ships normalized, unique plugin and connector identifiers", () => {
    expect(() => validatePluginCatalog(pluginCatalog)).not.toThrow();
    expect(new Set(pluginCatalog.map((plugin) => plugin.key)).size).toBe(pluginCatalog.length);
  });

  test("fixture tools declare schemas and conservative write defaults", () => {
    const fixture = pluginCatalog.find((plugin) => plugin.key === "openteam-utility-lab");
    const connector = fixture?.connections[0];
    expect(connector?.transport).toBe("builtin");
    expect(connector?.tools.map((tool) => tool.name)).toEqual(["echo", "add", "remember_note"]);
    expect(connector?.tools.find((tool) => tool.name === "remember_note")?.defaultDecision).toBe(
      "prompt"
    );
  });

  test("curates popular provider-hosted MCP integrations", () => {
    const expected = {
      gmail: "https://gmailmcp.googleapis.com/mcp/v1",
      "google-calendar": "https://calendarmcp.googleapis.com/mcp/v1",
      "google-drive": "https://drivemcp.googleapis.com/mcp/v1",
      github: "https://api.githubcopilot.com/mcp/",
      slack: "https://mcp.slack.com/mcp",
      notion: "https://mcp.notion.com/mcp",
      linear: "https://mcp.linear.app/mcp",
      atlassian: "https://mcp.atlassian.com/v1/mcp/authv2",
      asana: "https://mcp.asana.com/v2/mcp",
    };

    for (const [key, endpoint] of Object.entries(expected)) {
      const plugin = pluginCatalog.find((candidate) => candidate.key === key);
      expect(plugin?.featured).toBe(true);
      expect(plugin?.connections[0]?.endpoint).toBe(endpoint);
    }
    const githubSetup = pluginCatalog.find((plugin) => plugin.key === "github")?.setup;
    expect(githubSetup?.kind).toBe("token");
    expect(githubSetup?.connectionKey).toBe("github");
    expect(githubSetup?.fields).toHaveLength(1);
    expect(githubSetup?.fields[0]?.key).toBe("token");
    expect(githubSetup?.fields[0]?.secret).toBe(true);
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

    for (const key of ["gmail", "google-calendar", "google-drive", "slack", "asana"]) {
      const setup = pluginCatalog.find((plugin) => plugin.key === key)?.setup;
      expect(setup?.kind).toBe("oauth_client");
      expect(setup?.fields).toEqual([
        expect.objectContaining({ key: "clientId", required: true, secret: false }),
        expect.objectContaining({ key: "clientSecret", required: true, secret: true }),
      ]);
    }

    for (const key of ["notion", "linear", "atlassian"]) {
      expect(pluginCatalog.find((plugin) => plugin.key === key)?.setup).toMatchObject({
        kind: "oauth",
        fields: [],
      });
    }
  });

  test("rejects duplicate connector identities", () => {
    const source = pluginCatalog[0];
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
      text: "x".repeat(100_010),
      rows: Array.from({ length: 120 }, (_, index) => index),
      nested,
    }) as { text: string; rows: unknown[]; nested: unknown };
    expect(result.text).toEndWith("[truncated]");
    expect(result.rows).toHaveLength(101);
    expect(JSON.stringify(result.nested)).toContain("nested value omitted");
  });
});
