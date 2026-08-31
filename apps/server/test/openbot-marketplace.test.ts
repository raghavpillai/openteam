import { describe, expect, test } from "bun:test";
import {
  bundledOpenBotMarketplace,
  OpenBotMarketplaceSource,
  parseOpenBotMarketplace,
} from "../src/plugins/openbot-marketplace";

describe("OpenBot marketplace", () => {
  test("ships a first-party, versioned marketplace without an external catalog", async () => {
    const source = new OpenBotMarketplaceSource(undefined, bundledOpenBotMarketplace);
    const plugins = await source.plugins();

    expect(plugins).toHaveLength(11);
    expect(plugins.map((plugin) => plugin.key)).toContain("gmail");
    expect(plugins.map((plugin) => plugin.key)).toContain("github");
    expect(plugins.map((plugin) => plugin.key)).toContain("slack");
    expect(plugins.map((plugin) => plugin.key)).toContain("notion");
    expect(plugins.map((plugin) => plugin.key)).toContain("linear");
    expect(plugins.map((plugin) => plugin.key)).toContain("atlassian");
    expect(plugins.map((plugin) => plugin.key)).toContain("asana");
    expect(plugins.map((plugin) => plugin.key)).toContain("research-playbook");
    expect(plugins.every((plugin) => plugin.sourceRevision === "2026.08.29.4")).toBe(true);
  });

  test("accepts a deployment-owned marketplace manifest", async () => {
    const packageDefinition = {
      key: "self-hosted-mail-room",
      version: "1.2.3",
      name: "Mail Room",
      description: "Work with a self-hosted mail MCP.",
      publisher: "Example Company",
      category: "Inbox & Collaboration",
      featured: false,
      components: ["mcp" as const],
      homepageUrl: null,
      sourceUrl: null,
      sourceRevision: null,
      logoUrl: null,
      setupFields: [{ key: "MAIL_TOKEN", label: "Mail token", required: true, secret: true }],
      skills: [],
      connections: [
        {
          key: "mail",
          name: "Mail Room",
          transport: "http" as const,
          auth: "token" as const,
          endpoint: "https://mcp.example.test",
          configuration: { headers: { Authorization: String.raw`Bearer \${MAIL_TOKEN}` } },
          tools: [],
        },
      ],
    };
    const manifest = parseOpenBotMarketplace({
      schemaVersion: 1,
      revision: "example-7",
      plugins: [packageDefinition],
    });
    const source = new OpenBotMarketplaceSource(undefined, manifest);

    expect(await source.plugins()).toEqual([
      expect.objectContaining({
        key: "self-hosted-mail-room",
        version: "1.2.3",
        sourceRevision: "example-7",
      }),
    ]);
  });

  test("rejects malformed or duplicate marketplace packages", () => {
    expect(() =>
      parseOpenBotMarketplace({ schemaVersion: 2, revision: "bad", plugins: [] })
    ).toThrow("schemaVersion");
    expect(() =>
      parseOpenBotMarketplace({
        schemaVersion: 1,
        revision: "duplicate",
        plugins: [bundledOpenBotMarketplace.plugins[0], bundledOpenBotMarketplace.plugins[0]],
      })
    ).toThrow("Duplicate plugin key");
  });
});
