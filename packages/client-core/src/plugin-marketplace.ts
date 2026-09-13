import type { PluginCatalogItemView } from "@openteam/contracts";

export const PLUGIN_MARKETPLACE_CATEGORIES = [
  "All",
  "Featured",
  "Team plugins",
  "Agent Orchestration",
  "Canvas",
  "Customer Support",
  "Data & Analytics",
  "Design",
  "Documents and Files",
  "Finance and Legal",
  "Inbox and Collaboration",
  "Infrastructure",
  "MCP",
  "Payments",
  "Productivity",
  "Research",
  "Sales",
  "Scheduling",
] as const;

export type PluginMarketplaceCategory = (typeof PLUGIN_MARKETPLACE_CATEGORIES)[number];

const normalizedCategory = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s*(?:&|\band\b)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

type MarketplacePlugin = Pick<PluginCatalogItemView, "category" | "components" | "featured">;

export const pluginMatchesMarketplaceCategory = (
  plugin: MarketplacePlugin,
  category: string
): boolean => {
  if (category === "All") return true;
  if (category === "Featured") return plugin.featured;
  if (category === "Team plugins") return !plugin.featured;
  if (category === "MCP") return plugin.components.includes("mcp");
  return normalizedCategory(plugin.category) === normalizedCategory(category);
};
