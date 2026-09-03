import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release Compose rendering", () => {
  test("replaces every OpenTeam tag with its immutable multi-architecture digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-release-compose-"));
    temporaryDirectories.push(directory);
    const digestDirectory = join(directory, "digests");
    mkdirSync(digestDirectory);
    const services = ["server", "worker", "migrate", "computer"];
    for (const [index, service] of services.entries()) {
      await Bun.write(
        join(digestDirectory, `openteam-${service}.digest`),
        `sha256:${String(index + 1).repeat(64)}\n`
      );
    }
    const output = join(directory, "openteam-compose.yaml");
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../../scripts/render-release-compose.ts"),
        resolve(import.meta.dir, "../../../deploy/compose.yaml"),
        output,
        digestDirectory,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(await child.exited).toBe(0);
    const rendered = await Bun.file(output).text();
    for (const [index, service] of services.entries()) {
      expect(rendered).toContain(`-${service}@sha256:${String(index + 1).repeat(64)}`);
    }
    expect(rendered).not.toMatch(
      /^\s*image:.*-(?:server|worker|migrate|computer):\$\{OPENTEAM_VERSION/m
    );
    expect(rendered).toContain('profiles: ["https"]');
    expect(rendered).toContain("caddy:2.11.4-alpine@sha256:");
    expect(rendered).toContain("${OPENTEAM_VIEWER_BIND_HOST:-127.0.0.1}:6200-6299");
    expect(rendered).toContain("OPENTEAM_AUTH_URL: ${OPENTEAM_AUTH_URL");
    expect(rendered).not.toContain("OPENTEAM_PI_PROVIDER");
    expect(rendered).not.toContain("OPENTEAM_PI_MODEL");
    expect(rendered).not.toContain("OPENTEAM_PI_THINKING");
    expect(rendered).toContain('cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]');
  });
});
