import { describe, expect, test } from "bun:test";
import {
  compareOpenTeamVersions,
  defaultOpenTeamCompatibilityWindow,
  isOpenTeamVersion,
  normalizeOpenTeamVersion,
  openTeamCompatibility,
} from "@openteam/contracts/version-compatibility";

describe("OpenTeam release compatibility", () => {
  test("blocks incompatible lines while allowing patch-skewed releases", () => {
    expect(openTeamCompatibility("1.3.0", "1.2.0")).toBe("server-update-required");
    expect(openTeamCompatibility("1.2.0", "1.3.0")).toBe("client-update-required");
    expect(openTeamCompatibility("1.3.0", "1.3.0")).toBe("compatible");
    expect(openTeamCompatibility("1.3.1", "1.3.0")).toBe("update-recommended");
    expect(openTeamCompatibility("1.3.0", "1.3.1")).toBe("update-recommended");
    expect(openTeamCompatibility("1.3.0", "1.3.0", null)).toBe("unknown");
    expect(openTeamCompatibility("1.3.0", "1.3.0", 2)).toBe("client-update-required");
    expect(openTeamCompatibility("1.3.0", "1.3.0", 0)).toBe("server-update-required");
  });

  test("honors a server-provided overlapping compatibility window", () => {
    expect(
      openTeamCompatibility("1.3.9", "1.4.0", 1, {
        minimumClientVersion: "1.3.0",
        maximumClientVersionExclusive: "1.5.0",
      })
    ).toBe("update-recommended");
  });

  test("compares prereleases without accepting arbitrary update targets", () => {
    expect(compareOpenTeamVersions("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareOpenTeamVersions("2.0.0-rc.2", "2.0.0-rc.1")).toBeGreaterThan(0);
    expect(isOpenTeamVersion("latest")).toBe(false);
  });

  test("implements strict SemVer normalization without the full parser dependency", () => {
    expect(normalizeOpenTeamVersion(" v1.2.3+desktop.7 ")).toBe("1.2.3");
    expect(normalizeOpenTeamVersion("1.2.3-rc.01")).toBeNull();
    expect(normalizeOpenTeamVersion("01.2.3")).toBeNull();
    expect(normalizeOpenTeamVersion("9007199254740992.0.0")).toBeNull();
    expect(defaultOpenTeamCompatibilityWindow("2.9.4-rc.1")).toEqual({
      minimum: "2.9.0",
      maximumExclusive: "2.10.0",
    });

    const precedence = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let index = 1; index < precedence.length; index += 1) {
      expect(compareOpenTeamVersions(precedence[index - 1] ?? "", precedence[index] ?? "")).toBe(
        -1
      );
    }
  });

  test("keeps mismatch guidance visible before a user signs in", async () => {
    const authGate = await Bun.file(
      new URL("../src/renderer/components/openteam/auth-gate.tsx", import.meta.url)
    ).text();
    expect(authGate).toContain("<VersionMismatchBanner showReview={false} />");
  });

  test("confirms a successful desktop update check to the user", async () => {
    const [main, settings] = await Promise.all([
      Bun.file(new URL("../src/main/index.ts", import.meta.url)).text(),
      Bun.file(
        new URL("../src/renderer/components/openteam/settings/updates.tsx", import.meta.url)
      ).text(),
    ]);
    expect(main).toContain('message: updateAvailable ? null : "You’re up to date"');
    expect(settings).toContain('clientUpdate?.status === "up-to-date"');
  });
});
