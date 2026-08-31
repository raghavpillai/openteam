import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, writeFileAtomic } from "../src/config";
import { healthUrl } from "../src/health";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation health URL", () => {
  test("uses loopback to inspect a service bound to every interface", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-health-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(paths.environment, "OPENBOT_BIND_HOST=0.0.0.0\nOPENBOT_API_PORT=9444\n");
    expect(healthUrl(paths)).toBe("http://127.0.0.1:9444/api/v0/health");
  });
});
