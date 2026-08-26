import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";

const rendererRoot = resolve(import.meta.dirname, "..", "src", "renderer");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return sourceExtensions.has(extname(entry.name)) ? [path] : [];
    })
  );
  return nested.flat();
};

const violations: string[] = [];
for (const file of await sourceFiles(rendererRoot)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    if (specifier === "electron" || builtins.has(specifier)) {
      violations.push(`${relative(rendererRoot, file)} imports privileged module ${specifier}`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      const outsideRenderer = relative(rendererRoot, target).startsWith("..");
      if (outsideRenderer) {
        violations.push(
          `${relative(rendererRoot, file)} imports outside the renderer: ${specifier}`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Renderer boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}`
  );
  process.exit(1);
}
