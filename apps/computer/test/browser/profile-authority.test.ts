import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserProfileAuthority,
  PORTABLE_PROFILE_ENTRIES,
} from "../../src/browser/profile-authority";

describe("computer-scoped native browser profile authority", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  test("publishes stopped-profile state and hydrates a new bot profile", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-browser-profile-"));
    const alpha = join(home, "chrome-profile");
    const beta = join(home, "chrome-profile-2");
    await mkdir(join(alpha, "Default", "Extensions", "probe"), { recursive: true });
    await writeFile(join(alpha, "Local State"), '{"theme":"dark"}');
    await writeFile(join(alpha, "Default", "Login Data"), "encrypted-password-db");
    await writeFile(join(alpha, "Default", "Extensions", "probe", "manifest.json"), "{}");

    const authority = new BrowserProfileAuthority(home);
    await authority.publish(alpha);
    await authority.prepare(beta);

    expect(await readFile(join(beta, "Local State"), "utf8")).toBe('{"theme":"dark"}');
    expect(await readFile(join(beta, "Default", "Login Data"), "utf8")).toBe(
      "encrypted-password-db"
    );
    expect(
      await readFile(join(beta, "Default", "Extensions", "probe", "manifest.json"), "utf8")
    ).toBe("{}");
    expect(authority.clientCertificateStore()).toBe(join(home, ".pki", "nssdb"));
  });

  test("covers passwords, extensions, settings, history, bookmarks, and tabs", () => {
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Login Data");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Extensions");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Preferences");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/History");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Session Storage");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Bookmarks");
    expect(PORTABLE_PROFILE_ENTRIES).toContain("Default/Sessions");
  });

  test("does not let an older dormant profile replace an existing authority", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-browser-profile-seed-"));
    const alpha = join(home, "chrome-profile");
    const staleBeta = join(home, "chrome-profile-2");
    const gamma = join(home, "chrome-profile-3");
    await mkdir(join(alpha, "Default"), { recursive: true });
    await mkdir(join(staleBeta, "Default"), { recursive: true });
    await writeFile(join(alpha, "Default", "Preferences"), '{"authority":"alpha"}');
    await writeFile(join(staleBeta, "Default", "Preferences"), '{"authority":"stale-beta"}');

    const authority = new BrowserProfileAuthority(home);
    await authority.publish(alpha);
    await authority.seedIfEmpty(staleBeta);
    await authority.prepare(gamma);

    expect(await readFile(join(gamma, "Default", "Preferences"), "utf8")).toBe(
      '{"authority":"alpha"}'
    );
  });
});
