import { describe, expect, test } from "bun:test";
import {
  MACOS_RELEASE_ENTITLEMENTS,
  macosReleaseBuilderArgs,
  resolveMacosReleaseEnvironment,
} from "../scripts/macos-release-utils";

const packageJson = Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{
  build: {
    mac: { hardenedRuntime: boolean; icon: string; identity: string; notarize?: boolean };
  };
  scripts: Record<string, string>;
}>;

describe("macOS distribution release", () => {
  test("keeps normal packaging local, ad-hoc, and performance-gated", async () => {
    const desktop = await packageJson;

    expect(desktop.build.mac.identity).toBe("-");
    expect(desktop.build.mac.hardenedRuntime).toBe(false);
    expect(desktop.build.mac.notarize).not.toBe(true);
    expect(desktop.scripts.package).toContain("clean:release");
    expect(desktop.scripts.package).toContain("check-desktop-budgets.ts --release");
    expect(desktop.scripts.package).not.toContain("package-macos-release.ts");
  });

  test("requires an explicit signing identity and complete notarization credentials", () => {
    const identity = "Developer ID Application: OpenTeam";
    const apiKey = { CSC_NAME: identity, APPLE_API_KEY: "/private/key.p8", APPLE_API_KEY_ID: "KEY123", APPLE_API_ISSUER: "issuer" };
    expect(() => resolveMacosReleaseEnvironment({}, "darwin")).toThrow("CSC_NAME");
    expect(() => resolveMacosReleaseEnvironment({ CSC_NAME: identity, APPLE_ID: "release@example.com" }, "darwin")).toThrow("Incomplete macOS notarization credentials");
    expect(resolveMacosReleaseEnvironment(apiKey, "darwin")).toEqual({ identity, notarizationMode: "api-key" });
    expect(resolveMacosReleaseEnvironment({ ...apiKey, APPLE_TEAM_ID: "TEAM123" }, "darwin").notarizationMode).toBe("api-key");
    expect(() => resolveMacosReleaseEnvironment({ CSC_NAME: identity, APPLE_KEYCHAIN_PROFILE: "openteam-notary" }, "linux")).toThrow("only be built on macOS");
  });

  test("overrides every ad-hoc base setting in the signed release invocation", async () => {
    const desktop = await packageJson;
    const args = macosReleaseBuilderArgs("Developer ID Application: OpenTeam");
    const release = desktop.scripts["package:mac-release"];

    expect(args).toContain("-c.forceCodeSigning=true");
    expect(args).toContain("-c.mac.identity=Developer ID Application: OpenTeam");
    expect(args).toContain("-c.mac.hardenedRuntime=true");
    expect(args).toContain("-c.mac.notarize=true");
    expect(args).toContain(`-c.mac.entitlements=${MACOS_RELEASE_ENTITLEMENTS}`);
    expect(args).toContain(`-c.mac.entitlementsInherit=${MACOS_RELEASE_ENTITLEMENTS}`);
    expect(release).toContain("clean:release");
    expect(release).toContain("package-macos-release.ts");
    expect(release).toContain("check-desktop-budgets.ts --release");
    expect(release).toContain("verify:mac-notifications");
  });
});
