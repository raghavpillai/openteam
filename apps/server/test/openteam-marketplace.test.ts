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

    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.find(plugin => plugin.key === "1password")?.components).toEqual(["skills"]);
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
});
