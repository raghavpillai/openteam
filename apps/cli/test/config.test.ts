import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  defaultInstallDirectory,
  ensureAuthenticationSecret,
  installationPaths,
  normalizeRepository,
  normalizeVersion,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
} from "../src/config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation configuration", () => {
  test("uses a cross-platform per-user installation directory", () => {
    expect(defaultInstallDirectory({}, "darwin", "/Users/tester")).toBe("/Users/tester/.openteam");
    expect(defaultInstallDirectory({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/tester")).toBe(
      "/config/openteam"
    );
    expect(
      defaultInstallDirectory(
        { LOCALAPPDATA: "C:\\Users\\tester\\Local" },
        "win32",
        "C:\\Users\\tester"
      )
    ).toContain("OpenTeam");
  });

  test("creates random single-line secrets and stable release settings", () => {
    const first = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "Etc/UTC" }));
    const second = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "Etc/UTC" }));
    expect(first.get("OPENTEAM_VERSION")).toBe("1.2.3");
    expect(first.get("OPENTEAM_TIME_ZONE")).toBe("Etc/UTC");
    expect(first.get("OPENTEAM_BIND_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_VIEWER_BIND_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_PUBLIC_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENTEAM_PUBLIC_URL")).toBe("http://127.0.0.1:8787");
    expect(first.get("OPENTEAM_ACCESS_MODE")).toBe("local");
    expect(first.get("COMPOSE_PROFILES")).toBe("direct");
    expect(first.get("OPENTEAM_AUTH_MODE")).toBe("required");
    expect(first.has("OPENTEAM_PI_PROVIDER")).toBe(false);
    expect(first.has("OPENTEAM_PI_MODEL")).toBe(false);
    expect(first.has("OPENTEAM_PI_THINKING")).toBe(false);
    expect(first.get("OPENTEAM_CONTROL_TOKEN")).toHaveLength(64);
    expect(first.get("OPENTEAM_AUTH_SECRET")).toHaveLength(64);
    expect(first.get("OPENTEAM_PROXY_SECRET")).toHaveLength(64);
    expect(first.get("OPENTEAM_POSTGRES_PASSWORD")).toHaveLength(64);
    expect(first.get("OPENTEAM_CONTROL_TOKEN")).not.toBe(second.get("OPENTEAM_CONTROL_TOKEN"));
    expect(first.get("OPENTEAM_AUTH_SECRET")).not.toBe(second.get("OPENTEAM_AUTH_SECRET"));
    expect(first.get("OPENTEAM_PROXY_SECRET")).not.toBe(second.get("OPENTEAM_PROXY_SECRET"));
  });

  test("updates one environment setting without changing secrets", () => {
    const original = createEnvironment({ version: "1.0.0" });
    const updated = replaceEnvironmentValue(original, "OPENTEAM_VERSION", "1.1.0");
    const before = parseEnvironment(original);
    const after = parseEnvironment(updated);
    expect(after.get("OPENTEAM_VERSION")).toBe("1.1.0");
    expect(after.get("OPENTEAM_CONTROL_TOKEN")).toBe(before.get("OPENTEAM_CONTROL_TOKEN"));
    expect(after.get("OPENTEAM_AUTH_SECRET")).toBe(before.get("OPENTEAM_AUTH_SECRET"));
    expect(after.get("OPENTEAM_POSTGRES_PASSWORD")).toBe(before.get("OPENTEAM_POSTGRES_PASSWORD"));
  });

  test("upgrades a legacy environment with independent auth and proxy secrets", () => {
    const upgraded = parseEnvironment(
      ensureAuthenticationSecret("OPENTEAM_VERSION=1.0.0\nOPENTEAM_AUTH_SECRET=short\n")
    );
    expect(upgraded.get("OPENTEAM_AUTH_SECRET")).toHaveLength(64);
    expect(upgraded.get("OPENTEAM_PROXY_SECRET")).toHaveLength(64);
    expect(upgraded.get("OPENTEAM_AUTH_SECRET")).not.toBe(upgraded.get("OPENTEAM_PROXY_SECRET"));
  });

  test("writes secret files privately and atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-config-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(paths.environment, "SECRET=value\n", 0o600);
    expect(readFileSync(paths.environment, "utf8")).toBe("SECRET=value\n");
    if (process.platform !== "win32") expect(statSync(paths.environment).mode & 0o077).toBe(0);
  });

  test("normalizes release identifiers", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(() => normalizeVersion("latest")).toThrow("Invalid OpenTeam version");
    expect(() => normalizeRepository("not-a-repository")).toThrow("Invalid GitHub repository");
  });
});
