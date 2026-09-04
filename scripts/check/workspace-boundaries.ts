import { readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      if (["dist", "dist-web", "node_modules", "release", "coverage"].includes(entry.name)) {
        return [];
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return [walk(path)];
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return sourceExtensions.has(extension) ? [Promise.resolve([path])] : [];
    })
  );
  return nested.flat();
};

interface SourceImport {
  specifier: string;
  runtimeNames: string[];
}

const importsFor = async (file: string): Promise<SourceImport[]> => {
  const source = await Bun.file(file).text();
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  return parsed.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    const module = statement.moduleSpecifier;
    if (!module || !ts.isStringLiteral(module)) return [];
    if (ts.isExportDeclaration(statement)) {
      return [{ specifier: module.text, runtimeNames: statement.isTypeOnly ? [] : ["export"] }];
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return [{ specifier: module.text, runtimeNames: [] }];
    const runtimeNames: string[] = [];
    if (clause.name) runtimeNames.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings))
        runtimeNames.push(clause.namedBindings.name.text);
      else {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) runtimeNames.push(element.name.text);
        }
      }
    }
    return [{ specifier: module.text, runtimeNames }];
  });
};

const failures: string[] = [];
const serverOnlyPackages = new Set([
  "@openteam/computer",
  "@openteam/db",
  "@openteam/messaging",
  "@openteam/server",
  "@openteam/worker",
]);
const clientSourceDirectories = new Map<string, string[]>([
  ["desktop", [resolve(root, "apps", "desktop", "src")]],
  ["mobile", [resolve(root, "apps", "mobile", "src"), resolve(root, "apps", "mobile", "app")]],
  ["landing", [resolve(root, "apps", "landing", "src")]],
]);
for (const directories of clientSourceDirectories.values()) {
  for (const file of (
    await Promise.all(directories.map((directory) => walk(directory).catch(() => [])))
  ).flat()) {
    for (const imported of await importsFor(file)) {
      if (serverOnlyPackages.has(imported.specifier)) {
        failures.push(`${relative(root, file)} imports server-only ${imported.specifier}`);
      }
    }
  }
}

const neutralPackageImports = new Map<string, ReadonlySet<string>>([
  ["contracts", new Set()],
  ["client-core", new Set(["@openteam/contracts"])],
  ["product-core", new Set(["@openteam/contracts"])],
  ["design-tokens", new Set(["@openteam/contracts"])],
]);
const platformImportPrefixes = ["electron", "expo", "react", "react-native"];
for (const [packageName, allowedWorkspaceImports] of neutralPackageImports) {
  for (const file of await walk(resolve(root, "packages", packageName, "src"))) {
    for (const imported of await importsFor(file)) {
      if (
        imported.specifier.startsWith("@openteam/") &&
        ![...allowedWorkspaceImports].some(
          (allowed) =>
            imported.specifier === allowed || imported.specifier.startsWith(`${allowed}/`)
        )
      ) {
        failures.push(
          `${relative(root, file)} crosses the ${packageName} layer via ${imported.specifier}`
        );
      }
      if (
        packageName !== "client-core" &&
        platformImportPrefixes.some(
          (prefix) => imported.specifier === prefix || imported.specifier.startsWith(`${prefix}/`)
        )
      ) {
        failures.push(`${relative(root, file)} imports platform framework ${imported.specifier}`);
      }
      if (
        packageName === "client-core" &&
        platformImportPrefixes.some(
          (prefix) => imported.specifier === prefix || imported.specifier.startsWith(`${prefix}/`)
        )
      ) {
        failures.push(`${relative(root, file)} makes the API client platform-specific`);
      }
    }
  }
}

const clientLayerPackages = new Set([
  "@openteam/client-core",
  "@openteam/design-tokens",
  "@openteam/product-core",
]);
for (const owner of ["computer", "server", "worker"] as const) {
  for (const file of await walk(resolve(root, "apps", owner, "src"))) {
    for (const imported of await importsFor(file)) {
      if (clientLayerPackages.has(imported.specifier)) {
        failures.push(`${relative(root, file)} imports client-layer ${imported.specifier}`);
      }
    }
  }
}
for (const owner of ["db", "messaging"] as const) {
  for (const file of await walk(resolve(root, "packages", owner, "src"))) {
    for (const imported of await importsFor(file)) {
      if (clientLayerPackages.has(imported.specifier)) {
        failures.push(`${relative(root, file)} imports client-layer ${imported.specifier}`);
      }
    }
  }
}

for (const file of (await walk(resolve(root, "apps"))).filter(
  (candidate) => !candidate.split(sep).includes("test")
)) {
  const owner = relative(resolve(root, "apps"), file).split(sep)[0];
  for (const imported of await importsFor(file)) {
    if (!imported.specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), imported.specifier);
    const targetRelative = relative(resolve(root, "apps"), target);
    if (targetRelative.startsWith(`..${sep}`)) continue;
    const targetOwner = targetRelative.split(sep)[0];
    if (targetOwner && targetOwner !== owner) {
      failures.push(`${relative(root, file)} imports code from apps/${targetOwner}`);
    }
  }
}

for (const file of await walk(resolve(root, "apps", "mobile"))) {
  for (const imported of await importsFor(file)) {
    if (imported.specifier === "@openteam/contracts" && imported.runtimeNames.length > 0) {
      failures.push(
        `${relative(root, file)} imports root runtime values: ${imported.runtimeNames.join(", ")}`
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Workspace boundaries are valid");
