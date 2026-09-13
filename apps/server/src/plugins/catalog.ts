/** Compatibility exports; provider definitions belong in packages/plugins. */
export type { PluginDefinition, PluginSkillDefinition, PluginToolDefinition, PluginConnectorDefinition } from "@openteam/plugin-sdk";
export { validatePluginCatalog } from "@openteam/plugin-sdk";
import { pluginCatalog } from "@openteam/plugins";
export { pluginCatalog };
export const pluginDefinition = (key: string) => pluginCatalog.find((plugin) => plugin.key === key);
