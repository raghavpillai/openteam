import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const MIN_SHARED_LINES = 12;

interface SourceLine {
  line: number;
  text: string;
}

interface SourceWindow {
  file: string;
  line: number;
  signature: string;
}

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return [sourceFiles(path)];
        return /\.(?:ts|tsx)$/.test(entry.name) ? [Promise.resolve([path])] : [];
      })
    )
  ).flat();
};

const normalizedLines = (source: string): SourceLine[] =>
  source
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim().replace(/\s+/g, " ") }))
    .filter(
      ({ text }) =>
        text.length > 0 &&
        !text.startsWith("//") &&
        !text.startsWith("import ") &&
        !text.startsWith("export type ")
    );

const windowsFor = async (directories: string[]): Promise<SourceWindow[]> => {
  const files = (await Promise.all(directories.map(sourceFiles))).flat();
  const windows: SourceWindow[] = [];
  for (const file of files) {
    const lines = normalizedLines(await Bun.file(file).text());
    for (let index = 0; index + MIN_SHARED_LINES <= lines.length; index += 1) {
      windows.push({
        file,
        line: lines[index]!.line,
        signature: lines
          .slice(index, index + MIN_SHARED_LINES)
          .map(({ text }) => text)
          .join("\n"),
      });
    }
  }
  return windows;
};

const [desktop, mobile] = await Promise.all([
  windowsFor([resolve(root, "apps", "desktop", "src", "renderer")]),
  windowsFor([resolve(root, "apps", "mobile", "app"), resolve(root, "apps", "mobile", "src")]),
]);
const desktopBySignature = new Map<string, SourceWindow[]>();
for (const entry of desktop) {
  const matches = desktopBySignature.get(entry.signature) ?? [];
  matches.push(entry);
  desktopBySignature.set(entry.signature, matches);
}

const failures = new Set<string>();
for (const mobileEntry of mobile) {
  for (const desktopEntry of desktopBySignature.get(mobileEntry.signature) ?? []) {
    failures.add(
      `${relative(root, desktopEntry.file)}:${desktopEntry.line} duplicates ` +
        `${relative(root, mobileEntry.file)}:${mobileEntry.line}`
    );
  }
}

if (failures.size > 0) {
  console.error(
    [
      `Desktop and mobile share exact ${MIN_SHARED_LINES}-line source blocks:`,
      ...[...failures].slice(0, 40),
      "Move renderer-neutral behavior into packages/client-core, product-core, contracts, or design-tokens.",
    ].join("\n")
  );
  process.exit(1);
}

console.log("Desktop/mobile source duplication boundary is valid");
