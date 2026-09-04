import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  cliAssetName,
  cliPromotionEnvironment,
  downloadCliArtifact,
  isBunStandaloneExecutable,
  isStandaloneCliExecutable,
  promoteStagedCli,
  readCliPromotion,
  stageCliUpdate,
} from "../src/cli-update";

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const digest = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const artifactServer = (options: {
  raw: Uint8Array;
  filename?: string;
  signature?: string;
  corruptRawChecksum?: boolean;
}) => {
  const filename = options.filename ?? "openteam-darwin-arm64";
  const compressed = gzipSync(options.raw);
  const checksums = [
    `${options.corruptRawChecksum ? "0".repeat(64) : digest(options.raw)}  apps/cli/release/${filename}`,
    `${digest(compressed)}  apps/cli/release/${filename}.gz`,
  ].join("\n");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === `/${filename}.gz`) return new Response(compressed);
      if (pathname === `/${filename}`) return new Response(Buffer.from(options.raw));
      if (pathname === "/SHA256SUMS") return new Response(`${checksums}\n`);
      if (pathname === `/${filename}.sigstore.json` && options.signature) {
        return new Response(options.signature);
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    assetUrl: `${origin}/${filename}`,
    checksumUrl: `${origin}/SHA256SUMS`,
    signatureUrl: `${origin}/${filename}.sigstore.json`,
  };
};

describe("CLI self-update", () => {
  test("detects Bun's virtual executable entrypoint on Unix and Windows", () => {
    expect(
      isBunStandaloneExecutable(["/usr/local/bin/openteam", "/$bunfs/root/openteam", "update"], {
        bun: "1.3.8",
      })
    ).toBe(true);
    expect(
      isBunStandaloneExecutable(
        ["C:\\OpenTeam\\openteam.exe", "B:\\~BUN\\root\\openteam.exe", "update"],
        { bun: "1.3.8" }
      )
    ).toBe(true);
  });

  test("detects native standalone launches without treating Desktop as installable CLI", () => {
    expect(
      isStandaloneCliExecutable(
        ["/usr/local/bin/openteam", "/$bunfs/root/openteam", "update"],
        "/usr/local/bin/openteam",
        { bun: "1.3.8" },
        "darwin",
        true
      )
    ).toBe(true);
    expect(
      isStandaloneCliExecutable(
        ["/Applications/OpenTeam", "/resources/openteam-cli.js", "update"],
        "/Applications/OpenTeam",
        { electron: "43.4.1" },
        "darwin"
      )
    ).toBe(false);
    expect(
      isStandaloneCliExecutable(
        ["/usr/bin/node", "/app/openteam.js", "update"],
        "/usr/bin/node",
        { node: "24.0.0" },
        "linux"
      )
    ).toBe(false);
  });

  test("selects each published host asset", () => {
    expect(cliAssetName("darwin", "arm64")).toBe("openteam-darwin-arm64");
    expect(cliAssetName("linux", "x64")).toBe("openteam-linux-x64");
    expect(cliAssetName("win32", "arm64")).toBe("openteam-windows-x64.exe");
    expect(() => cliAssetName("freebsd", "x64")).toThrow("does not publish");
  });

  test("verifies compressed and raw checksums plus the release Sigstore identity", async () => {
    const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
    const raw = new Uint8Array(readFileSync(fixture("release-v0.1.0/openteam-compose.yaml")));
    const signature = readFileSync(
      fixture("release-v0.1.0/openteam-compose.yaml.sigstore.json"),
      "utf8"
    );
    const release = artifactServer({ raw, signature });
    const downloaded = await downloadCliArtifact({
      repository: "raghavpillai/openteam",
      version: "0.1.0",
      ...release,
      platform: "darwin",
      architecture: "arm64",
    });
    expect(downloaded.bytes).toEqual(raw);
  });

  test("rejects a CLI whose decompressed checksum does not match", async () => {
    const release = artifactServer({
      raw: new TextEncoder().encode("not trusted"),
      corruptRawChecksum: true,
    });
    await expect(
      downloadCliArtifact({
        repository: "owner/repo",
        version: "1.2.3",
        ...release,
        allowUnsigned: true,
        platform: "darwin",
        architecture: "arm64",
      })
    ).rejects.toThrow("Checksum verification failed");
  });

  test("stages a runnable CLI beside the installed binary and promotes it with rollback copy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-update-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "openteam");
    writeFileSync(target, "#!/bin/sh\necho 1.1.0\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    const nextContents = new TextEncoder().encode("#!/bin/sh\necho 1.2.3\n");
    const release = artifactServer({ raw: nextContents });
    const staged = await stageCliUpdate({
      repository: "owner/repo",
      version: "1.2.3",
      executable: target,
      ...release,
      allowUnsigned: true,
      platform: "darwin",
      architecture: "arm64",
      validateCandidate: async (source) => {
        expect(readFileSync(source, "utf8")).toBe("#!/bin/sh\necho 1.2.3\n");
        return { status: 0, stdout: "1.2.3\n", detail: null };
      },
    });
    const environment = cliPromotionEnvironment(staged, 123);
    const promotion = readCliPromotion(environment, staged.source, "1.2.3", "darwin");
    expect(promotion).toMatchObject({ ...staged, followerPid: 123 });
    if (!promotion) throw new Error("promotion missing");
    const backup = promoteStagedCli(promotion, "darwin");
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho 1.2.3\n");
    expect(readFileSync(backup, "utf8")).toBe("#!/bin/sh\necho 1.1.0\n");
  });

  test("uses a non-running copy for the Windows swap and retains the prior executable", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-update-windows-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "openteam.exe");
    const source = join(directory, ".openteam.exe.update-1.2.3-test");
    writeFileSync(target, "old executable");
    writeFileSync(source, "new executable");
    const backup = promoteStagedCli(
      { source, target, version: "1.2.3", followerPid: null },
      "win32"
    );
    expect(readFileSync(target, "utf8")).toBe("new executable");
    expect(readFileSync(backup, "utf8")).toBe("old executable");
  });
});
