import { basename } from "node:path";

export const PACKAGED_APP_TOP_LEVEL = ["dist", "dist-electron", "package.json"] as const;

export type ReleaseArtifactKind = "appImage" | "asar" | "dmg" | "nsis" | "zip";

export const releaseArtifactKind = (path: string): ReleaseArtifactKind | null => {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (lower === "app.asar") return "asar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".appimage")) return "appImage";
  if (lower.endsWith(".exe") && !lower.endsWith(".exe.blockmap")) return "nsis";
  return null;
};

/** Installer/archive outputs live at the release root. Only app.asar is
 * expected inside an unpacked application directory. */
export const isReleaseArtifactLocation = (relativePath: string, kind: ReleaseArtifactKind) =>
  kind === "asar" || !relativePath.replaceAll("\\", "/").includes("/");

export const zipAsarEntries = (listing: string) =>
  listing
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => /(?:^|\/)resources\/app\.asar$/i.test(entry));

export const expectedReleaseArtifactKinds = (platform: NodeJS.Platform): ReleaseArtifactKind[] => {
  if (platform === "darwin") return ["zip", "dmg"];
  if (platform === "linux") return ["appImage"];
  if (platform === "win32") return ["nsis"];
  return [];
};

export const validatePackagedTopLevel = (actualNames: string[]) => {
  const actual = new Set(actualNames);
  const expected = new Set<string>(PACKAGED_APP_TOP_LEVEL);
  return {
    missing: PACKAGED_APP_TOP_LEVEL.filter((name) => !actual.has(name)),
    unexpected: [...actual].filter((name) => !expected.has(name)).sort(),
  };
};

export interface PackagedMetadataExpectation {
  author?: unknown;
  description?: unknown;
  main: string;
  name: string;
  private?: unknown;
  type?: unknown;
  version: string;
}

export const validatePackagedPackageJson = (
  value: unknown,
  expected: PackagedMetadataExpectation,
  packagedPaths: ReadonlySet<string>
) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["package.json is not an object"];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of [
    "name",
    "version",
    "description",
    "author",
    "private",
    "type",
    "main",
  ] as const) {
    if (record[field] !== expected[field]) {
      errors.push(`package.json ${field} does not match the desktop package`);
    }
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "scripts",
    "build",
  ] as const) {
    if (field in record) errors.push(`package.json unexpectedly contains ${field}`);
  }
  const allowed = new Set(["name", "version", "description", "author", "private", "type", "main"]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) errors.push(`package.json contains unexpected field ${field}`);
  }
  if (typeof record.main !== "string" || !packagedPaths.has(record.main)) {
    errors.push("package.json main does not resolve to a packaged file");
  }
  return errors;
};
