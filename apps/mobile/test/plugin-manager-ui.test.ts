import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("mobile plugin manager scale and access wiring", () => {
  test("presents the native marketplace hierarchy and category menu", async () => {
    const [marketplace, sharedMarketplace] = await Promise.all([
      source("src/components/plugin-marketplace-sheet.tsx"),
      source("../../packages/client-core/src/plugin-marketplace.ts"),
    ]);

    expect(sharedMarketplace).toContain('"Team plugins"');
    expect(sharedMarketplace).toContain('"Agent Orchestration"');
    expect(sharedMarketplace).toContain('"Documents And Files"');
    expect(marketplace).toContain("PLUGIN_MARKETPLACE_CATEGORIES.map");
    expect(marketplace).toContain("pluginMatchesMarketplaceCategory(plugin, category)");
    expect(marketplace).toContain('accessibilityLabel="Search plugins"');
    expect(marketplace).toContain('label="Filter plugins"');
    expect(marketplace).toContain("data.installs.length} installed");
    expect(marketplace).toContain("<GlassSurface");
    expect(marketplace).toContain("featured.slice(0, 4)");
    expect(marketplace).toContain("BundledGoogleMark");
    expect(marketplace).toContain('name === "Google Calendar"');
    expect(marketplace).toContain('name === "Google Drive"');
  });

  test("uses the shared server page boundary with searchable, abortable paging", async () => {
    const manager = await source("src/components/plugin-manager-sheet.tsx");
    const context = await source("src/state/openbot-context.tsx");

    expect(manager).toContain("PLUGIN_BOT_ACCESS_PAGE_SIZE");
    expect(manager).toContain("PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH");
    expect(manager).toContain("query: accessQuery");
    expect(manager).toContain("offset: accessOffset");
    expect(manager).toContain("signal: controller.signal");
    expect(manager).toContain("controller.abort()");
    expect(manager).toContain('accessibilityLabel="Previous Bot access page"');
    expect(manager).toContain('accessibilityLabel="Next Bot access page"');
    expect(context).toContain("operationClient.pluginBotAccess(pluginKey, query)");
    expect(context).not.toContain("pluginBotAccess(pluginKey, { limit: 200 })");
  });

  test("keeps skill access separate from explicit connection grants", async () => {
    const manager = await source("src/components/plugin-manager-sheet.tsx");
    const context = await source("src/state/openbot-context.tsx");

    expect(manager).toContain("planPluginSkillAccess(accessPluginKey, bot, enabled)");
    expect(manager).toContain(
      "planPluginConnectionGrant(accessPluginKey, bot, connection.id, enabled)"
    );
    expect(manager).toContain("executePluginAccessTransition(transition");
    expect(manager).toContain("rollback: () => updateAccessBot(bot.id, () => transition.previous)");
    expect(manager).toContain("bot.grantedConnectionIds.includes(connection.id)");
    expect(manager).toContain("refreshSettings: false");
    expect(context).toContain("operationClient.setPluginGrant(connectionId, botId, enabled)");
    expect(context).toContain(
      "operationClient.setPluginEnablement(pluginKey, botId, enabled, skillsEnabled)"
    );
  });
});
