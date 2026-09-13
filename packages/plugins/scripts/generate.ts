import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { importPackage, validatePluginCatalog, type PluginDefinition } from "@openteam/plugin-sdk";

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
    const files: Record<string, string> = {};
    const binaryFiles: Record<string, string> = {};
    const entry = join(directory, folder.name, "connector/server.ts");
    if (await Bun.file(entry).exists()) {
      const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
      if (!result.success) throw new AggregateError(result.logs, `Cannot build ${folder.name}`);
      // Bundle shared source into each portable package; installing needs no package manager.
      files["connector/server.mjs"] = await result.outputs[0]!.text();
      if (["gmail", "google-calendar", "google-drive"].includes(folder.name))
        files["GOOGLE-REFERENCE-NOTICE.md"] = await readFile(join(root, "_shared/reference/README.md"), "utf8");
    }
    const walk = async (path = "") => {
      for (const entry of await readdir(join(directory, folder.name, path), {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store")
          continue;
        const relative = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink())
          throw new Error(`Plugin packages cannot contain symlinks: ${folder.name}/${relative}`);
        if (entry.isDirectory()) await walk(relative);
        else {
          const bytes = await readFile(join(directory, folder.name, relative));
          try {
            if (!(relative in files))
              files[relative] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            binaryFiles[relative] = bytes.toString("base64");
          }
        }
      }
    };
    await walk();
    if (!files["plugin.json"]) throw new Error(`Missing ${folder.name}/plugin.json`);
    const { definition } = importPackage(files);
    definitions.push({
      ...definition,
      ...(Object.keys(binaryFiles).length ? { binaryFiles } : {}),
    });
  }
  definitions.sort((left, right) =>
    left.key === "openteam-utility-lab"
      ? -1
      : right.key === "openteam-utility-lab"
        ? 1
        : left.key.localeCompare(right.key)
  );
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
