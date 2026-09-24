import { importPackage } from "./package";
import { parsePluginDefinition } from "./manifest";
import type { PluginDefinition } from "./types";

export const UPSTREAM_DIRECTORY = "upstream";

/** Keep the original package intact; project its workflows without rewriting source files. */
export function assembleUpstreamPlugin(
  definition: PluginDefinition,
  files: Record<string, string>,
  binaryFiles: Record<string, string> = {}
): PluginDefinition {
  const source = definition.upstream;
  if (!source) throw new Error("Plugin has no pinned source");
  // Download completion order must not change skill ordering or the reviewed package digest.
  files = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
  binaryFiles = Object.fromEntries(
    Object.entries(binaryFiles).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  );
  const projected = importPackage(files).definition;
  const overlay = (assets: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(assets).filter(([path]) => !path.startsWith(`${UPSTREAM_DIRECTORY}/`))
    );
  return parsePluginDefinition({
    ...definition,
    components: [
      ...(definition.connections.length ? ["mcp" as const] : []),
      ...projected.components.filter((component) => component !== "mcp"),
    ],
    skills: projected.skills.map((skill) => ({
      ...skill,
      path: `${UPSTREAM_DIRECTORY}/${skill.path}`,
    })),
    files: {
      ...overlay(definition.files),
      ...Object.fromEntries(
        Object.entries(files).map(([path, body]) => [`${UPSTREAM_DIRECTORY}/${path}`, body])
      ),
    },
    binaryFiles: {
      ...overlay(definition.binaryFiles),
      ...Object.fromEntries(
        Object.entries(binaryFiles).map(([path, body]) => [`${UPSTREAM_DIRECTORY}/${path}`, body])
      ),
    },
  });
}
