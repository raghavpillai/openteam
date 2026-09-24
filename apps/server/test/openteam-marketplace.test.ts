import { describe, expect, test } from "bun:test";
import {
  bundledOpenTeamMarketplace,
  OpenTeamMarketplaceSource,
  parseOpenTeamMarketplace,
} from "../src/plugins/openteam-marketplace";

describe("OpenTeam marketplace", () => {
  test("ships a first-party, versioned marketplace without an external catalog", async () => {
    const source = new OpenTeamMarketplaceSource(undefined, bundledOpenTeamMarketplace);
    const plugins = await source.plugins();

    expect(plugins.length).toBeGreaterThanOrEqual(10);
    expect(plugins.map((plugin) => plugin.key)).not.toContain("onedrive");
    expect(plugins.map((plugin) => plugin.key)).toContain("google-drive");
    expect(plugins.map((plugin) => plugin.key)).toContain("gmail");
    expect(plugins.map((plugin) => plugin.key)).toContain("github");
    expect(plugins.map((plugin) => plugin.key)).toContain("slack");
    expect(plugins.map((plugin) => plugin.key)).toContain("notion");
    expect(plugins.map((plugin) => plugin.key)).toContain("linear");
    expect(plugins.map((plugin) => plugin.key)).not.toContain("atlassian");
    expect(plugins.map((plugin) => plugin.key)).not.toContain("asana");
    expect(plugins.map((plugin) => plugin.key)).not.toContain("research-playbook");
    // Upstream packages pin their own revision; unpinned packages use the catalog revision.
    expect(plugins.map((plugin) => plugin.sourceRevision)).toEqual(
      bundledOpenTeamMarketplace.plugins.map((plugin) => plugin.sourceRevision ?? bundledOpenTeamMarketplace.revision)
    );
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
    const manifest = parseOpenTeamMarketplace({
      schemaVersion: 1,
      revision: "example-7",
      plugins: [packageDefinition],
    });
    const source = new OpenTeamMarketplaceSource(undefined, manifest);

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
      parseOpenTeamMarketplace({ schemaVersion: 2, revision: "bad", plugins: [] })
    ).toThrow("schemaVersion");
    expect(() =>
      parseOpenTeamMarketplace({
        schemaVersion: 1,
        revision: "duplicate",
        plugins: [bundledOpenTeamMarketplace.plugins[0], bundledOpenTeamMarketplace.plugins[0]],
      })
    ).toThrow("Duplicate plugin key");
  });
});
