import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, writeFileAtomic } from "../src/config";
import { checkHealth, healthUrl } from "../src/health";

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation health URL", () => {
  test("uses loopback to inspect a service bound to every interface", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-health-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(paths.environment, "OPENTEAM_BIND_HOST=0.0.0.0\nOPENTEAM_API_PORT=9444\n");
    expect(healthUrl(paths)).toBe("http://127.0.0.1:9444/api/v0/health");
  });

  test("requires ready status and the exact target release", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-health-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    let status = "degraded";
    let version = "1.2.3";
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status, release: { releaseVersion: version } }),
    });
    servers.push(server);
    writeFileAtomic(paths.environment, `OPENTEAM_API_PORT=${server.port}\n`);

    expect((await checkHealth(paths)).detail).toBe("runtime is degraded");
    status = "ready";
    expect((await checkHealth(paths, "1.3.0")).detail).toContain("1.2.3 is responding");
    version = "1.3.0";
    expect(await checkHealth(paths, "1.3.0")).toMatchObject({ ok: true, version: "1.3.0" });
  });
});
