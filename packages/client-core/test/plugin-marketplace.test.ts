import { describe, expect, test } from "bun:test";
import type { PluginCatalogItemView } from "@openteam/contracts";
import {
  PLUGIN_MARKETPLACE_CATEGORIES,
  pluginMatchesMarketplaceCategory,
} from "../src/plugin-marketplace";

const plugin: Pick<PluginCatalogItemView, "category" | "components" | "featured"> = {
  category: "Documents & Files",
  components: ["mcp", "skills"],
  featured: true,
};

describe("plugin marketplace categories", () => {
  test("keeps the shared category order stable", () => {
    expect(PLUGIN_MARKETPLACE_CATEGORIES[0]).toBe("All");
    expect(PLUGIN_MARKETPLACE_CATEGORIES.at(-1)).toBe("Scheduling");
  });

  test("matches synthetic and aliased categories consistently", () => {
    expect(pluginMatchesMarketplaceCategory(plugin, "All")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Featured")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Team plugins")).toBe(false);
    expect(pluginMatchesMarketplaceCategory(plugin, "MCP")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Documents And Files")).toBe(true);
    expect(
      pluginMatchesMarketplaceCategory(
        { ...plugin, category: "Inbox & Collaboration" },
        "Inbox And Collaboration"
      )
    ).toBe(true);
  });
});
