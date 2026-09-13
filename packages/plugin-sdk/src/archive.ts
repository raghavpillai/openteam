import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parsePluginDefinition, safePackagePath } from "./manifest";
import { exportPackage, importPackage, PACKAGE_MAX_BYTES, PACKAGE_MAX_FILES } from "./package";
import type { PackagePreview, PluginDefinition } from "./types";

export function importPackageArchive(bytes: Uint8Array): PackagePreview {
  if (bytes.length > PACKAGE_MAX_BYTES) throw new Error("Package archive exceeds 20 MB");
  let total = 0;
  let count = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.endsWith("/")) return false;
      safePackagePath(entry.name);
      total += entry.originalSize;
      if (++count > PACKAGE_MAX_FILES || !Number.isFinite(total) || total > PACKAGE_MAX_BYTES)
        throw new Error("Expanded package exceeds its size or file limit");
      return true;
    },
  });
  const paths = Object.keys(entries);
  const manifests = paths.filter(
    (path) =>
      path === "plugin.json" ||
      path === ".cursor-plugin/plugin.json" ||
      path.endsWith("/plugin.json")
  );
  const roots = [
    ...new Set(
      manifests.map((path) =>
        path.endsWith(".cursor-plugin/plugin.json")
          ? path.slice(0, -".cursor-plugin/plugin.json".length)
          : path.slice(0, -"plugin.json".length)
      )
    ),
  ];
  const root = roots.includes("") ? "" : roots.length === 1 ? roots[0]! : null;
  if (root === null)
    throw new Error("Archive must contain one plugin package; choose its folder or release bundle");
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(entries)) {
    if (!path.startsWith(root)) continue;
    const relative = safePackagePath(path.slice(root.length));
    try {
      files[relative] = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      binaryFiles[relative] = btoa(
        Array.from(content, (byte) => String.fromCharCode(byte)).join("")
      );
    }
  }
  const preview = importPackage(files);
  preview.definition.binaryFiles = binaryFiles;
  preview.definition = parsePluginDefinition(preview.definition);
  return preview;
}

export function exportPackageArchive(plugin: PluginDefinition): Uint8Array {
  const entries = Object.fromEntries(
    Object.entries(exportPackage(plugin)).map(([path, value]) => [path, strToU8(value)])
  );
  for (const [path, content] of Object.entries(plugin.binaryFiles ?? {}))
    entries[safePackagePath(path)] = Uint8Array.from(atob(content), (value) => value.charCodeAt(0));
  return zipSync(entries, { level: 6 });
}

export function archivePackageFiles(files: Record<string, Uint8Array>): Uint8Array {
  let size = 0;
  if (Object.keys(files).length > PACKAGE_MAX_FILES) throw new Error("Package exceeds 1,000 files");
  for (const [path, content] of Object.entries(files)) {
    safePackagePath(path);
    size += content.length;
  }
  if (size > PACKAGE_MAX_BYTES) throw new Error("Package exceeds 20 MB");
  return zipSync(files, { level: 6 });
}
