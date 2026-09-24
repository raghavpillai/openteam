import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assembleUpstreamPlugin,
  importPackage,
  validatePluginCatalog,
  type PluginDefinition,
} from "@openteam/plugin-sdk";

const root = join(import.meta.dir, "..");
export async function discoverPackages(directory = root): Promise<PluginDefinition[]> {
  const definitions: PluginDefinition[] = [];
  const folders = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith("_") &&
      !entry.name.startsWith(".") &&
      !["node_modules", "src", "dist", "scripts", "test"].includes(entry.name)
  );
  for (const folder of folders) {
    const provenanceFile = Bun.file(join(directory, folder.name, "upstream.json"));
    const provenance = (await provenanceFile.exists()) ? await provenanceFile.json() : null;
    const files: Record<string, string> = {};
    const binaryFiles: Record<string, string> = {};
    const entry = join(directory, folder.name, "connector/server.ts");
    if (await Bun.file(entry).exists()) {
      const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
      if (!result.success) throw new AggregateError(result.logs, `Cannot build ${folder.name}`);
      // Bundle shared source into each portable package; installing needs no package manager.
      files["connector/server.mjs"] = await result.outputs[0]!.text();
      if (["gmail", "google-calendar", "google-drive"].includes(folder.name))
        files["GOOGLE-REFERENCE-NOTICE.md"] = await readFile(
          join(root, "_shared/reference/README.md"),
          "utf8"
        );
    }
    const walk = async (path = "") => {
      for (const entry of await readdir(join(directory, folder.name, path), {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store")
          continue;
        const relative = path ? `${path}/${entry.name}` : entry.name;
        if (relative === "upstream.json") continue;
        if (entry.isSymbolicLink())
          throw new Error(`Plugin packages cannot contain symlinks: ${folder.name}/${relative}`);
        if (entry.isDirectory()) await walk(relative);
        else {
          const bytes = await readFile(join(directory, folder.name, relative));
          try {
            if (!(relative in files))
              files[relative] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                bytes
              );
          } catch {
            binaryFiles[relative] = bytes.toString("base64");
          }
        }
      }
    };
    await walk();
    if (!files["plugin.json"]) throw new Error(`Missing ${folder.name}/plugin.json`);
    let { definition } = importPackage(files);
    definition = {
      ...definition,
      ...(Object.keys(binaryFiles).length ? { binaryFiles } : {}),
      ...(provenance?.repository
        ? {
            upstream: provenance,
            sourceUrl: `https://github.com/${provenance.repository}/tree/${provenance.revision}${provenance.directory ? `/${provenance.directory}` : ""}`,
            sourceRevision: provenance.revision,
          }
        : {}),
    };
    if (definition.upstream && definition.upstream.delivery !== "install") {
      for (const path of [...Object.keys(files), ...Object.keys(binaryFiles)]) {
        if (path.startsWith("upstream/") && !(path.slice(9) in definition.upstream.files))
          throw new Error(`${folder.name}/${path} is absent from the pinned source inventory`);
      }
      const upstreamFiles: Record<string, string> = {};
      const upstreamBinary: Record<string, string> = {};
      for (const [path, expected] of Object.entries(definition.upstream.files)) {
        const bytes = await readFile(join(directory, folder.name, "upstream", path));
        if (createHash("sha256").update(bytes).digest("hex") !== expected)
          throw new Error(`${folder.name}/upstream/${path} differs from its pinned source`);
        if (`upstream/${path}` in binaryFiles) upstreamBinary[path] = bytes.toString("base64");
        else upstreamFiles[path] = bytes.toString("utf8");
      }
      if (definition.upstream.delivery === "bundled")
        definition = assembleUpstreamPlugin(definition, upstreamFiles, upstreamBinary);
    }
    definitions.push(definition);
  }
  definitions.sort((left, right) => left.key.localeCompare(right.key));
  validatePluginCatalog(definitions);
  return definitions;
}
if (import.meta.main) {
  const plugins = await discoverPackages();
  await mkdir(join(root, "_generated"), { recursive: true });
  await writeFile(
    join(root, "_generated", "registry.json"),
    `${JSON.stringify(plugins, null, 2)}\n`
  );
  console.log(`Validated and packaged ${plugins.length} plugins`);
}
