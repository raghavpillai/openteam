import { describe, expect, test } from "bun:test";
import type { PluginCatalogItemView } from "@openteam/contracts";
import {
  pluginMatchesMarketplaceCategory,
} from "../src/plugin-marketplace";

const plugin: Pick<PluginCatalogItemView, "category" | "components" | "featured"> = {
  category: "Documents & Files",
  components: ["mcp", "skills"],
  featured: true,
};

describe("plugin marketplace categories", () => {
  test("matches synthetic and aliased categories consistently", () => {
    expect(pluginMatchesMarketplaceCategory(plugin, "All")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Featured")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Team plugins")).toBe(false);
    expect(pluginMatchesMarketplaceCategory(plugin, "MCP")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Documents And Files")).toBe(true);
    expect(pluginMatchesMarketplaceCategory(plugin, "Documents and Files")).toBe(true);
    expect(
      pluginMatchesMarketplaceCategory(
        { ...plugin, category: "Finance Legal" },
        "Finance and Legal"
      )
    ).toBe(true);
    expect(
      pluginMatchesMarketplaceCategory(
        { ...plugin, category: "Inbox & Collaboration" },
        "Inbox And Collaboration"
      )
    ).toBe(true);
  });
});
