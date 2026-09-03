import type { PluginCatalogItemView } from "@openteam/contracts";

export const PLUGIN_MARKETPLACE_CATEGORIES = [
  "All",
  "Featured",
  "Team plugins",
  "Agent Orchestration",
  "Canvas",
  "Customer Support",
  "Data Analytics",
  "Design",
  "Documents And Files",
  "Finance And Legal",
  "Inbox And Collaboration",
  "Infrastructure",
  "MCP",
  "Payments",
  "Productivity",
  "Research",
  "Sales",
  "Scheduling",
] as const;

export type PluginMarketplaceCategory = (typeof PLUGIN_MARKETPLACE_CATEGORIES)[number];

const PLUGIN_MARKETPLACE_CATEGORY_ALIASES: Partial<Record<PluginMarketplaceCategory, string>> = {
  "Documents And Files": "Documents & Files",
  "Inbox And Collaboration": "Inbox & Collaboration",
};

type MarketplacePlugin = Pick<PluginCatalogItemView, "category" | "components" | "featured">;

export const pluginMatchesMarketplaceCategory = (
  plugin: MarketplacePlugin,
  category: PluginMarketplaceCategory
): boolean => {
  if (category === "All") return true;
  if (category === "Featured") return plugin.featured;
  if (category === "Team plugins") return !plugin.featured;
  if (category === "MCP") return plugin.components.includes("mcp");
  return plugin.category === (PLUGIN_MARKETPLACE_CATEGORY_ALIASES[category] ?? category);
};
