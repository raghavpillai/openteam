import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expectedReleaseArtifactKinds,
  isReleaseArtifactLocation,
  isSignedMacHelper,
  isExpectedNativeModule,
  matchesResignedMacExecutable,
  releaseArtifactKind,
  validatePackagedPackageJson,
  validatePackagedTopLevel,
  zipAsarEntries,
} from "./desktop-build-measurement-utils";

test.skipIf(process.platform !== "darwin")("re-signing preserves executable equivalence but changed or invalid code does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-signature-test-"));
  const run = (args: string[]) => expect(Bun.spawnSync(args).exitCode).toBe(0);
  try {
    const input = join(root, "main.c"), original = join(root, "original"), resigned = join(root, "resigned");
    await writeFile(input, "int main(void) { return 0; }\n");
    run(["cc", input, "-o", original]);
    run(["codesign", "--force", "--sign", "-", "--identifier", "original", original]);
    await copyFile(original, resigned);
    run(["codesign", "--force", "--sign", "-", "--identifier", "replacement", resigned]);
    const source = await readFile(original), packaged = await readFile(resigned);
    expect(source.equals(packaged)).toBe(false);
    expect(await matchesResignedMacExecutable(source, packaged)).toBe(true);
    await writeFile(input, "int main(void) { return 1; }\n");
    run(["cc", input, "-o", resigned]);
    run(["codesign", "--force", "--sign", "-", resigned]);
    expect(await matchesResignedMacExecutable(source, await readFile(resigned))).toBe(false);
    expect(await matchesResignedMacExecutable(source, Buffer.from("invalid executable"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged license must match source metadata", () => {
  const expected = { name: "desktop", version: "0.0.0", main: "main.js", license: "GPL-3.0-only" };
  expect(validatePackagedPackageJson(expected, expected, new Set(["main.js"]))).toEqual([]);
  expect(validatePackagedPackageJson({ ...expected, license: "MIT" }, expected, new Set(["main.js"]))).toContain("package.json license does not match the desktop package");
});

describe("desktop build measurement utilities", () => {
  test("discovers release artifacts without assuming version or architecture", () => {
    expect(
      releaseArtifactKind("/release/mac-universal/OpenTeam.app/Contents/Resources/app.asar")
    ).toBe("asar");
    expect(releaseArtifactKind("/release/OpenTeam-9.7.0-mac-x64.zip")).toBe("zip");
    expect(releaseArtifactKind("/release/OpenTeam-9.7.0-arm64.dmg")).toBe("dmg");
    expect(releaseArtifactKind("/release/OpenTeam-9.7.0.AppImage")).toBe("appImage");
    expect(releaseArtifactKind("C:\\release\\OpenTeam Setup 9.7.0.exe")).toBe("nsis");
    expect(releaseArtifactKind("/release/latest-mac.yml")).toBeNull();
    expect(expectedReleaseArtifactKinds("darwin")).toEqual(["zip", "dmg"]);
    expect(expectedReleaseArtifactKinds("linux")).toEqual(["appImage"]);
    expect(expectedReleaseArtifactKinds("win32")).toEqual(["nsis"]);
    expect(isReleaseArtifactLocation("OpenTeam Setup 9.7.0.exe", "nsis")).toBe(true);
    expect(isReleaseArtifactLocation("win-unpacked/OpenTeam.exe", "nsis")).toBe(false);
    expect(isReleaseArtifactLocation("win-unpacked/resources/app.asar", "asar")).toBe(true);
    expect(
      zipAsarEntries(
        "OpenTeam.app/Contents/Resources/app.asar\nOpenTeam.app/Contents/Frameworks/Electron.framework/Resources/default_app.asar\n"
      )
    ).toEqual(["OpenTeam.app/Contents/Resources/app.asar"]);
  });

  test("enforces the packaged top-level allow-list", () => {
    expect(validatePackagedTopLevel(["package.json", "dist-electron", "dist"])).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(validatePackagedTopLevel(["dist", "src"])).toEqual({
      missing: ["dist-electron", "package.json"],
      unexpected: ["src"],
    });
  });

  test("accepts only pruned package metadata with a packaged main", () => {
    const expected = {
      author: "OpenTeam contributors",
      description: "Desktop",
      main: "dist-electron/main.js",
      name: "@openteam/desktop",
      private: true,
      type: "module",
      version: "2.0.0",
    };
    const packagedPaths = new Set(["dist-electron/main.js"]);
    expect(validatePackagedPackageJson(expected, expected, packagedPaths)).toEqual([]);
    expect(
      validatePackagedPackageJson(
        { ...expected, dependencies: { react: "19" }, main: "missing.js" },
        expected,
        packagedPaths
      )
    ).toEqual([
      "package.json main does not match the desktop package",
      "package.json unexpectedly contains dependencies",
      "package.json contains unexpected field dependencies",
      "package.json main does not resolve to a packaged file",
    ]);
  });
});

test.skipIf(process.platform !== "darwin")("universal helper permits compiler-unsigned x64 but requires every packaged slice signed and unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-universal-signature-test-"));
  const run = (args: string[]) => expect(Bun.spawnSync(args).exitCode).toBe(0);
  try {
    const input = join(root, "main.c"), original = join(root, "original"), resigned = join(root, "resigned");
    const parts = ["x86_64", "arm64"].map(arch => join(root, arch));
    await writeFile(input, '#include <stdio.h>\nint main(void) { puts("fixture-code-constant"); return 0; }\n');
    for (const [i, arch] of ["x86_64", "arm64"].entries()) run(["cc", "-arch", arch, "-mmacosx-version-min=12.0", input, "-o", parts[i]!]);
    // Swift's shipping helper likewise has an unsigned x64 slice and ad-hoc arm64.
    const x64Signature = Bun.spawnSync(["codesign", "--verify", "--strict", parts[0]!]);
    if (x64Signature.exitCode === 0) run(["codesign", "--remove-signature", parts[0]!]);
    run(["lipo", "-create", ...parts, "-output", original]);
    await copyFile(original, resigned);
    const entitlements = join(root, "entitlements.plist");
    await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
    run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, resigned]);
    const source = await readFile(original), packaged = await readFile(resigned);
    expect(source.equals(packaged)).toBe(false);
    expect(await matchesResignedMacExecutable(source, packaged)).toBe(true);
    expect(await matchesResignedMacExecutable(source, source)).toBe(false);
    const tampered = Buffer.from(packaged);
    const marker = tampered.indexOf("fixture-code-constant");
    expect(marker).toBeGreaterThan(0); tampered[marker] ^= 1;
    expect(await matchesResignedMacExecutable(source, tampered)).toBe(false);
    run(["codesign", "--force", "--sign", "-", join(root, "arm64")]);
    expect(await matchesResignedMacExecutable(source, await readFile(join(root, "arm64")))).toBe(false);
    await writeFile(input, '#include <stdio.h>\nint main(void) { puts("different-program"); return 1; }\n');
    for (const [i, arch] of ["x86_64", "arm64"].entries()) run(["cc", "-arch", arch, "-mmacosx-version-min=12.0", input, "-o", parts[i]!]);
    run(["lipo", "-create", ...parts, "-output", resigned]);
    run(["codesign", "--force", "--sign", "-", resigned]);
    expect(await matchesResignedMacExecutable(source, await readFile(resigned))).toBe(false);
    expect(source.equals(await readFile(original))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only the exact unpacked first-party macOS location addon is permitted", () => {
  expect(isExpectedNativeModule("dist-electron/location.node", true, "darwin")).toBe(true);
  expect(isExpectedNativeModule("dist-electron/location.node", false, "darwin")).toBe(false);
  for (const platform of ["linux", "win32"] as const) {
    expect(isExpectedNativeModule("dist-electron/location.node", true, platform)).toBe(false);
    expect(isSignedMacHelper("dist-electron/location.node", platform)).toBe(false);
  }
  for (const path of ["location.node", "dist-electron/foreign.node", "dist-electron/nested/location.node", "node_modules/location.node", "dist/location.node", "dist-electron/location.node/extra", "dist-electron/../dist-electron/location.node"]) {
    expect(isExpectedNativeModule(path, true, "darwin")).toBe(false);
    expect(isSignedMacHelper(path, "darwin")).toBe(false);
  }
  expect(isSignedMacHelper("dist-electron/location.node", "darwin")).toBe(true);
  expect(isSignedMacHelper("dist-electron/screenbot-keys", "darwin")).toBe(true);
});

test.skipIf(process.platform !== "darwin")("universal native bundles require signed unchanged code in both architectures", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-native-bundle-test-"));
  const run = (args: string[]) => expect(Bun.spawnSync(args).exitCode).toBe(0);
  try {
    const input = join(root, "bridge.c"), original = join(root, "location.node"), packaged = join(root, "packaged.node");
    const parts = ["x86_64", "arm64"].map(arch => join(root, arch));
    await writeFile(input, "int fixture_location_bridge(void) { return 7; }\n");
    for (const [i, arch] of ["x86_64", "arm64"].entries()) run(["cc", "-arch", arch, "-mmacosx-version-min=12.0", "-bundle", "-undefined", "dynamic_lookup", input, "-o", parts[i]!]);
    const x64Signature = Bun.spawnSync(["codesign", "--verify", "--strict", parts[0]!]);
    if (x64Signature.exitCode === 0) run(["codesign", "--remove-signature", parts[0]!]);
    run(["lipo", "-create", ...parts, "-output", original]);
    await copyFile(original, packaged);
    run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", "signed.location.fixture", packaged]);
    const before = await readFile(original), signed = await readFile(packaged);
    expect(before.equals(signed)).toBe(false);
    expect(await matchesResignedMacExecutable(before, signed)).toBe(true);
    expect(await matchesResignedMacExecutable(before, before)).toBe(false);
    expect(await matchesResignedMacExecutable(before, await readFile(parts[1]!))).toBe(false);
    await writeFile(input, "int fixture_location_bridge(void) { return 8; }\n");
    for (const [i, arch] of ["x86_64", "arm64"].entries()) run(["cc", "-arch", arch, "-mmacosx-version-min=12.0", "-bundle", "-undefined", "dynamic_lookup", input, "-o", parts[i]!]);
    run(["lipo", "-create", ...parts, "-output", packaged]);
    run(["codesign", "--force", "--sign", "-", packaged]);
    expect(await matchesResignedMacExecutable(before, await readFile(packaged))).toBe(false);
    expect((await readFile(original)).equals(before)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
