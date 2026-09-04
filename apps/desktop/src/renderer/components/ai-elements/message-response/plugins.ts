import type { PluginConfig } from "streamdown";
import type { AdvancedMessageCapabilities } from "./capabilities";

const pluginConfigByCapability = new Map<string, Promise<PluginConfig>>();

const capabilityKey = ({ cjk, code, math, mermaid }: AdvancedMessageCapabilities) =>
  `${Number(cjk)}${Number(code)}${Number(math)}${Number(mermaid)}`;

/** Starts independent feature requests together so splitting the plug-ins does
 * not turn rich rendering into a serial network waterfall. */
export const loadAdvancedMessagePlugins = (capabilities: AdvancedMessageCapabilities) => {
  const key = capabilityKey(capabilities);
  const existing = pluginConfigByCapability.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const plugins: PluginConfig = {};
    await Promise.all([
      capabilities.cjk
        ? import("./cjk").then((module) => {
            plugins.cjk = module.cjk;
          })
        : undefined,
      capabilities.code
        ? import("./code").then((module) => {
            plugins.code = module.code;
          })
        : undefined,
      capabilities.math
        ? import("./math").then((module) => {
            plugins.math = module.math;
          })
        : undefined,
      capabilities.mermaid
        ? import("./mermaid").then((module) => {
            plugins.mermaid = module.mermaid;
          })
        : undefined,
    ]);
    return plugins;
  })();
  pluginConfigByCapability.set(key, promise);
  return promise;
};
