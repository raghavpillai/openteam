import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, writeFileAtomic } from "../src/config";
import { checkHealth, healthUrl, waitForHealth } from "../src/health";

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation health URL", () => {
  test.each([
    200, 503,
  ])("rejects unavailable dependencies even if the API says ready (HTTP %s)", async (httpStatus) => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-health-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            status: "ready",
            runtime: { database: "unavailable", queue: "unavailable", computer: "ready" },
          },
          { status: httpStatus }
        ),
    });
    servers.push(server);
    writeFileAtomic(paths.environment, `OPENTEAM_API_PORT=${server.port}\n`);
    const result = await checkHealth(paths);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("database: unavailable");
    expect(result.detail).toContain("queue: unavailable");
    expect(result.components?.computer).toBe("ready");
  });
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

  test("distinguishes connection failures from an HTTP readiness failure and prints the cause", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-health-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    const server = Bun.serve({ port: 0, fetch: () => new Response("starting", { status: 503 }) });
    servers.push(server);
    writeFileAtomic(paths.environment, `OPENTEAM_API_PORT=${server.port}\n`);
    expect(await checkHealth(paths)).toMatchObject({ ok: false, detail: "HTTP 503" });
    expect((await checkHealth(paths)).connectionFailed).toBeUndefined();
    server.stop(true);
    expect(await checkHealth(paths)).toMatchObject({ ok: false, connectionFailed: true });

    const output: string[] = [];
    const writer = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const result = await waitForHealth(paths, 0);
      expect(result.ok).toBe(false);
      expect(output.join("")).toContain(result.url);
      expect(output.join("")).toContain(result.detail);
      expect(output.join("")).toContain("s elapsed");
    } finally {
      writer.mockRestore();
    }
  });
});
