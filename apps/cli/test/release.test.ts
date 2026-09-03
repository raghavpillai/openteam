import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  downloadRelease,
  releaseComposeUrl,
  validateCompose,
  verifyReleaseSignature,
} from "../src/release";

const compose = `name: openteam
services:
  server:
    image: example/openteam-server:\${OPENTEAM_VERSION}
volumes:
  openteam_workspace:
`;

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("release downloads", () => {
  test("builds a version-pinned GitHub release URL", () => {
    expect(releaseComposeUrl("owner/repo", "1.2.3")).toBe(
      "https://github.com/owner/repo/releases/download/v1.2.3/openteam-compose.yaml"
    );
  });

  test("verifies the Compose release checksum", async () => {
    const digest = createHash("sha256").update(compose).digest("hex");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/openteam-compose.yaml") return new Response(compose);
        if (pathname === "/SHA256SUMS") {
          return new Response(`${digest}  openteam-compose.yaml\n`);
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const release = await downloadRelease({
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: `${origin}/openteam-compose.yaml`,
      checksumUrl: `${origin}/SHA256SUMS`,
      allowUnsigned: true,
    });
    expect(release.compose).toBe(compose);
    expect(release.version).toBe("1.2.3");
  });

  test("rejects a checksum mismatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/openteam-compose.yaml"
          ? new Response(compose)
          : new Response(`${"0".repeat(64)}  openteam-compose.yaml\n`);
      },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    await expect(
      downloadRelease({
        repository: "owner/repo",
        version: "1.2.3",
        composeUrl: `${origin}/openteam-compose.yaml`,
        checksumUrl: `${origin}/SHA256SUMS`,
        allowUnsigned: true,
      })
    ).rejects.toThrow("Checksum verification failed");
  });

  test("rejects unrelated Compose content", () => {
    expect(() => validateCompose("services:\n  app:\n    image: example\n")).toThrow(
      "unexpected size"
    );
  });

  test("fails closed for a malformed or untrusted Sigstore bundle", async () => {
    await expect(
      verifyReleaseSignature({
        repository: "owner/repo",
        version: "1.2.3",
        compose,
        serializedBundle: "{}",
      })
    ).rejects.toThrow("Sigstore verification failed");
  });
});
