import type { PluginRuntimeAsset } from "./types";

export function validateRuntimeAssets(
  value: unknown
): asserts value is PluginRuntimeAsset[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw new Error("Declare between 1 and 8 managed runtime assets");
  const names = new Set<string>();
  for (const asset of value) {
    if (
      !asset ||
      typeof asset !== "object" ||
      Array.isArray(asset) ||
      typeof asset.name !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,31}$/.test(asset.name) ||
      names.has(asset.name)
    )
      throw new Error("Managed runtime names must be unique uppercase identifiers");
    names.add(asset.name);
    if (asset.optional !== undefined && typeof asset.optional !== "boolean")
      throw new Error("Invalid managed runtime optional flag");
    if (
      !asset.sources ||
      typeof asset.sources !== "object" ||
      Array.isArray(asset.sources) ||
      !Object.keys(asset.sources).length
    )
      throw new Error("Managed runtime assets need platform-specific sources");
    for (const [platform, source] of Object.entries(asset.sources) as Array<[string, any]>) {
      if (
        !/^[a-z][a-z0-9]*-(?:x64|arm64)$/.test(platform) ||
        !source ||
        typeof source !== "object" ||
        Array.isArray(source)
      )
        throw new Error("Invalid managed runtime platform");
      if (typeof source.url !== "string" || typeof source.sha256 !== "string")
        throw new Error("Managed runtime URL and SHA-256 must be strings");
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        throw new Error("Invalid managed runtime URL");
      }
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error("Managed runtime URLs require HTTPS without credentials or fragments");
      if (!/^[a-f0-9]{64}$/.test(source.sha256))
        throw new Error("Managed runtime assets need SHA-256 pins");
      if (
        !Number.isSafeInteger(source.bytes) ||
        source.bytes < 1 ||
        source.bytes > 512 * 1024 * 1024 ||
        !Number.isSafeInteger(source.maxExtractedBytes) ||
        source.maxExtractedBytes < source.bytes ||
        source.maxExtractedBytes > 2 * 1024 * 1024 * 1024
      )
        throw new Error("Managed runtime size limits are invalid");
      if (
        !["tar.gz", "file"].includes(source.format) ||
        typeof source.path !== "string" ||
        !source.path ||
        source.path.startsWith("/") ||
        /[\\\x00-\x1f:]/.test(source.path) ||
        source.path.split("/").some((part: string) => !part || part === "." || part === "..")
      )
        throw new Error("Managed runtime entry points must stay inside their asset directory");
      if (source.executable !== undefined && typeof source.executable !== "boolean")
        throw new Error("Invalid managed runtime executable flag");
    }
  }
}
