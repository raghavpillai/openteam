import type { PluginDefinition } from "./types";

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
export const PLUGIN_ICON_MAX_BASE64_LENGTH = Math.ceil((256 * 1024) / 3) * 4;

/** Package-owned raster icons work offline in both desktop and native mobile images. */
export function pluginIconUrl(
  plugin: Pick<PluginDefinition, "icon" | "binaryFiles" | "logoUrl">
): string | null {
  if (plugin.icon) {
    const content = plugin.binaryFiles?.[plugin.icon];
    const type = imageTypes[plugin.icon.split(".").at(-1)?.toLowerCase() ?? ""];
    if (content && type && content.length <= PLUGIN_ICON_MAX_BASE64_LENGTH)
      return `data:${type};base64,${content}`;
  }
  return typeof plugin.logoUrl === "string" &&
    /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;base64)?,)/i.test(plugin.logoUrl)
    ? plugin.logoUrl
    : null;
}
