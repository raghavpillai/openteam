import { basename } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Validate the thin 64-bit Mach-O layout before normalizing signing metadata. */
function macExecutableLayout(bytes: Buffer, signedLayout: boolean) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) return null;
  const count = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20);
  if (count > 256 || size > bytes.length - 32) return null;
  let at = 32, linkEdit: number | undefined, signature = false;
  for (let i = 0; i < count; i++) {
    if (at + 8 > size + 32) return null;
    const command = bytes.readUInt32LE(at), length = bytes.readUInt32LE(at + 4);
    if (length < 8 || at + length > size + 32) return null;
    if (command === 0x19 && length >= 72 && bytes.toString("ascii", at + 8, at + 24).replace(/\0+$/, "") === "__LINKEDIT") {
      if (linkEdit !== undefined) return null;
      linkEdit = at;
    }
    if (command === 0x1d) {
      if (signature || length !== 16) return null;
      const offset = bytes.readUInt32LE(at + 8), size = bytes.readUInt32LE(at + 12);
      if (!size || offset + size !== bytes.length) return null;
      signature = true;
    }
    at += length;
  }
  if (at !== size + 32 || linkEdit === undefined) return null;
  const offset = bytes.readBigUInt64LE(linkEdit + 40), fileSize = bytes.readBigUInt64LE(linkEdit + 48);
  if (offset + fileSize !== BigInt(bytes.length)) return null;
  const vmSize = bytes.readBigUInt64LE(linkEdit + 32);
  const align = (value: bigint, page: bigint) => (value + page - 1n) / page * page;
  // The linker uses 4 KB/16 KB pages; codesign may reserve 16 KB even on x64.
  // Reject arbitrary virtual-space changes, rather than masking the whole segment.
  if (signedLayout && vmSize !== align(fileSize, 4096n) && vmSize !== align(fileSize, 16384n)) return null;
  return { signature, normalizedVMSize: align(fileSize, 16384n), linkEdit };
}

/** Compare every architecture's code; only signatures and their reserved VM space differ. */
export async function matchesResignedMacExecutable(source: Buffer, packaged: Buffer): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const directory = await mkdtemp(join(tmpdir(), "openteam-signature-compare-"));
  const run = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  try {
    const paths = [join(directory, "source"), join(directory, "packaged")];
    await writeFile(paths[0]!, source, { mode: 0o600 });
    await writeFile(paths[1]!, packaged, { mode: 0o600 });
    // Compiler output may have an unsigned x64 slice; the distributed helper may not.
    if (run(["/usr/bin/codesign", "--verify", "--strict", "--all-architectures", paths[1]!]).exitCode !== 0) return false;
    const architectures = paths.map(path => run(["/usr/bin/lipo", "-archs", path]));
    if (architectures.some(result => result.exitCode !== 0)) return false;
    const names = architectures.map(result => result.stdout.toString().trim().split(/\s+/).sort());
    if (!names[0]!.length || names[0]!.length > 2 || JSON.stringify(names[0]) !== JSON.stringify(names[1]) ||
      new Set(names[0]).size !== names[0]!.length || names[0]!.some(name => !["arm64", "x86_64"].includes(name))) return false;
    for (const architecture of names[0]!) {
      const normalized: Buffer[] = [];
      for (const [index, path] of paths.entries()) {
        const thin = join(directory, `${index}-${architecture}`);
        const input = index === 0 ? source : packaged;
        if (input.readUInt32LE(0) === 0xfeedfacf) await writeFile(thin, input, { mode: 0o600 });
        else if (run(["/usr/bin/lipo", path, "-thin", architecture, "-output", thin]).exitCode !== 0) return false;
        const original = macExecutableLayout(await readFile(thin), true);
        if (!original || (index === 1 && !original.signature)) return false;
        if (original.signature) {
          if (run(["/usr/bin/codesign", "--verify", "--strict", thin]).exitCode !== 0 ||
            run(["/usr/bin/codesign", "--remove-signature", thin]).exitCode !== 0) return false;
        }
        const bytes = await readFile(thin), layout = macExecutableLayout(bytes, false);
        if (!layout || layout.signature) return false;
        // codesign leaves __LINKEDIT.vmsize at its signed allocation after removal.
        // All other load commands, sections, symbols and executable bytes stay exact.
        bytes.writeBigUInt64LE(layout.normalizedVMSize, layout.linkEdit + 32);
        normalized.push(bytes);
      }
      if (!normalized[0]!.equals(normalized[1]!)) return false;
    }
    return true;
  } catch { return false; }
  finally { await rm(directory, { recursive: true, force: true }); }
}

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
  license?: unknown;
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
    "license",
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
  const allowed = new Set(["name", "license", "version", "description", "author", "private", "type", "main"]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) errors.push(`package.json contains unexpected field ${field}`);
  }
  if (typeof record.main !== "string" || !packagedPaths.has(record.main)) {
    errors.push("package.json main does not resolve to a packaged file");
  }
  return errors;
};
