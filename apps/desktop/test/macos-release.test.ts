import { describe, expect, test } from "bun:test";
import {
  MACOS_RELEASE_ENTITLEMENTS,
  macosReleaseBuilderArgs,
  resolveMacosReleaseEnvironment,
} from "../scripts/macos-release-utils";

const packageJson = Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{
  build: {
    mac: { hardenedRuntime: boolean; icon: string; identity: string; notarize?: boolean };
    linux: { icon: string };
    win: { icon: string };
  };
  scripts: Record<string, string>;
}>;
const verificationSource = Bun.file(
  new URL("../scripts/verify-macos-notifications.ts", import.meta.url)
).text();
const entitlementsSource = Bun.file(
  new URL("../build/entitlements.mac.plist", import.meta.url)
).text();

describe("macOS distribution release", () => {
  test("uses the OpenBot app icon on every desktop platform", async () => {
    const desktop = await packageJson;
    const expected = "../mobile/assets/openbot-icon-v2.png";

    expect(desktop.build.mac.icon).toBe(expected);
    expect(desktop.build.linux.icon).toBe(expected);
    expect(desktop.build.win.icon).toBe(expected);
    expect(await Bun.file(new URL(`../${expected}`, import.meta.url)).exists()).toBe(true);
  });

  test("keeps normal packaging local, ad-hoc, and performance-gated", async () => {
    const desktop = await packageJson;

    expect(desktop.build.mac.identity).toBe("-");
    expect(desktop.build.mac.hardenedRuntime).toBe(false);
    expect(desktop.build.mac.notarize).not.toBe(true);
    expect(desktop.scripts.package).toContain("clean:release");
    expect(desktop.scripts.package).toContain("check-desktop-budgets.ts --release");
    expect(desktop.scripts.package).not.toContain("package-macos-release.ts");
  });

  test("keeps the explicit local macOS notification audit credential-free", async () => {
    const desktop = await packageJson;
    const local = desktop.scripts["package:mac-local"];

    expect(local).toContain("clean:release-local");
    expect(local).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(local).toContain("-c.mac.identity=-");
    expect(local).toContain("-c.mac.hardenedRuntime=false");
    expect(local).toContain("-c.mac.notarize=false");
    expect(local).toContain("--allow-adhoc release-local");
  });

  test("requires an explicit signing identity and complete notarization credentials", () => {
    expect(() => resolveMacosReleaseEnvironment({}, "darwin")).toThrow("CSC_NAME");
    expect(() =>
      resolveMacosReleaseEnvironment(
        { CSC_NAME: "Developer ID Application: OpenBot", APPLE_ID: "release@example.com" },
        "darwin"
      )
    ).toThrow("Incomplete macOS notarization credentials");
    expect(
      resolveMacosReleaseEnvironment(
        {
          CSC_NAME: "Developer ID Application: OpenBot",
          APPLE_API_KEY: "/private/key.p8",
          APPLE_API_KEY_ID: "KEY123",
          APPLE_API_ISSUER: "issuer",
        },
        "darwin"
      )
    ).toEqual({
      identity: "Developer ID Application: OpenBot",
      notarizationMode: "api-key",
    });
    expect(
      resolveMacosReleaseEnvironment(
        {
          CSC_NAME: "Developer ID Application: OpenBot",
          APPLE_TEAM_ID: "TEAM123",
          APPLE_API_KEY: "/private/key.p8",
          APPLE_API_KEY_ID: "KEY123",
          APPLE_API_ISSUER: "issuer",
        },
        "darwin"
      ).notarizationMode
    ).toBe("api-key");
    expect(() =>
      resolveMacosReleaseEnvironment(
        {
          CSC_NAME: "Developer ID Application: OpenBot",
          APPLE_KEYCHAIN_PROFILE: "openbot-notary",
        },
        "linux"
      )
    ).toThrow("only be built on macOS");
  });

  test("overrides every ad-hoc base setting in the signed release invocation", async () => {
    const desktop = await packageJson;
    const args = macosReleaseBuilderArgs("Developer ID Application: OpenBot");
    const release = desktop.scripts["package:mac-release"];

    expect(args).toContain("-c.forceCodeSigning=true");
    expect(args).toContain("-c.mac.identity=Developer ID Application: OpenBot");
    expect(args).toContain("-c.mac.hardenedRuntime=true");
    expect(args).toContain("-c.mac.notarize=true");
    expect(args).toContain(`-c.mac.entitlements=${MACOS_RELEASE_ENTITLEMENTS}`);
    expect(args).toContain(`-c.mac.entitlementsInherit=${MACOS_RELEASE_ENTITLEMENTS}`);
    expect(release).toContain("clean:release");
    expect(release).toContain("package-macos-release.ts");
    expect(release).toContain("check-desktop-budgets.ts --release");
    expect(release).toContain("verify:mac-notifications");
  });

  test("verifies Developer ID, hardened runtime, entitlements, Gatekeeper, and notarization", async () => {
    const [source, entitlements] = await Promise.all([verificationSource, entitlementsSource]);

    expect(source).toContain("Authority=Developer ID Application:");
    expect(source).toContain("flags=.*\\bruntime\\b");
    expect(source).toContain('"--entitlements"');
    expect(source).toContain('"--xml"');
    expect(source).toContain("com.apple.security.cs.allow-jit");
    expect(source).toContain('"spctl"');
    expect(source).toContain('"stapler"');
    expect(source).toContain('"validate"');
    expect(source).toContain("dev.openbot.desktop");
    for (const entitlement of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(entitlements).toContain(`<key>${entitlement}</key>`);
    }
  });
});
