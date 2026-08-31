import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  defaultInstallDirectory,
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
    expect(defaultInstallDirectory({}, "darwin", "/Users/tester")).toBe("/Users/tester/.openbot");
    expect(defaultInstallDirectory({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/tester")).toBe(
      "/config/openbot"
    );
    expect(
      defaultInstallDirectory(
        { LOCALAPPDATA: "C:\\Users\\tester\\Local" },
        "win32",
        "C:\\Users\\tester"
      )
    ).toContain("OpenBot");
  });

  test("creates random single-line secrets and stable release settings", () => {
    const first = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "Etc/UTC" }));
    const second = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "Etc/UTC" }));
    expect(first.get("OPENBOT_VERSION")).toBe("1.2.3");
    expect(first.get("OPENBOT_TIME_ZONE")).toBe("Etc/UTC");
    expect(first.get("OPENBOT_BIND_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENBOT_PUBLIC_HOST")).toBe("127.0.0.1");
    expect(first.get("OPENBOT_CONTROL_TOKEN")).toHaveLength(64);
    expect(first.get("OPENBOT_AUTH_SECRET")).toHaveLength(64);
    expect(first.get("OPENBOT_POSTGRES_PASSWORD")).toHaveLength(64);
    expect(first.get("OPENBOT_CONTROL_TOKEN")).not.toBe(second.get("OPENBOT_CONTROL_TOKEN"));
    expect(first.get("OPENBOT_AUTH_SECRET")).not.toBe(second.get("OPENBOT_AUTH_SECRET"));
  });

  test("updates one environment setting without changing secrets", () => {
    const original = createEnvironment({ version: "1.0.0" });
    const updated = replaceEnvironmentValue(original, "OPENBOT_VERSION", "1.1.0");
    const before = parseEnvironment(original);
    const after = parseEnvironment(updated);
    expect(after.get("OPENBOT_VERSION")).toBe("1.1.0");
    expect(after.get("OPENBOT_CONTROL_TOKEN")).toBe(before.get("OPENBOT_CONTROL_TOKEN"));
    expect(after.get("OPENBOT_AUTH_SECRET")).toBe(before.get("OPENBOT_AUTH_SECRET"));
    expect(after.get("OPENBOT_POSTGRES_PASSWORD")).toBe(before.get("OPENBOT_POSTGRES_PASSWORD"));
  });

  test("writes secret files privately and atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-config-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(paths.environment, "SECRET=value\n", 0o600);
    expect(readFileSync(paths.environment, "utf8")).toBe("SECRET=value\n");
    if (process.platform !== "win32") expect(statSync(paths.environment).mode & 0o077).toBe(0);
  });

  test("normalizes release identifiers", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(() => normalizeVersion("latest")).toThrow("Invalid OpenBot version");
    expect(() => normalizeRepository("not-a-repository")).toThrow("Invalid GitHub repository");
  });
});
