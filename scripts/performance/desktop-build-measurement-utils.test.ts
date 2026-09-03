import { describe, expect, test } from "bun:test";
import {
  expectedReleaseArtifactKinds,
  isReleaseArtifactLocation,
  releaseArtifactKind,
  validatePackagedPackageJson,
  validatePackagedTopLevel,
  zipAsarEntries,
} from "./desktop-build-measurement-utils";

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
