import { expect, test } from "bun:test";
import { bundledOpenTeamMarketplace, OpenTeamMarketplaceSource, parseOpenTeamMarketplace } from "../src/plugins/openteam-marketplace";

test("ships a first-party, versioned marketplace and accepts a deployment-owned manifest", async () => {
  const plugins = await new OpenTeamMarketplaceSource(undefined, bundledOpenTeamMarketplace).plugins();
  expect(plugins.find(plugin => plugin.key === "1password")?.components).toEqual(["skills"]);
  // Upstream packages pin their own revision; unpinned packages use the catalog revision.
  expect(plugins.map((plugin) => plugin.sourceRevision)).toEqual(
    bundledOpenTeamMarketplace.plugins.map((plugin) => plugin.sourceRevision ?? bundledOpenTeamMarketplace.revision));
  const manifest = parseOpenTeamMarketplace({ schemaVersion: 1, revision: "example-7", plugins: [{
    key: "self-hosted-mail-room", version: "1.2.3", name: "Mail Room", description: "Work with a self-hosted mail MCP.", publisher: "Example Company",
    category: "Inbox & Collaboration", featured: false, components: ["mcp"], homepageUrl: null, sourceUrl: null, sourceRevision: null, logoUrl: null,
    setupFields: [{ key: "MAIL_TOKEN", label: "Mail token", required: true, secret: true }], skills: [],
    connections: [{ key: "mail", name: "Mail Room", transport: "http", auth: "token", endpoint: "https://mcp.example.test",
      configuration: { headers: { Authorization: String.raw`Bearer \${MAIL_TOKEN}` } }, tools: [] }],
  }] });
  expect(await new OpenTeamMarketplaceSource(undefined, manifest).plugins()).toEqual([
    expect.objectContaining({ key: "self-hosted-mail-room", version: "1.2.3", sourceRevision: "example-7" }),
  ]);
});
