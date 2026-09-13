import registry from "../_generated/registry.json";
import { parsePluginDefinition } from "@openteam/plugin-sdk";
export const pluginCatalog = registry.map(parsePluginDefinition);
