import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  cliPromotionEnvironment,
  downloadCliArtifact,
  promoteStagedCli,
  readCliPromotion,
  removeCurrentCli,
  stageCliUpdate,
} from "../src/cli-update";
import { scratch } from "./fixtures/harness";

const s = scratch();
const digest = (contents: Uint8Array) => createHash("sha256").update(contents).digest("hex");

/** Release assets for one CLI build, listed in SHA256SUMS by their release-tree path. */
const artifactServer = (
  raw: Uint8Array,
  options: { signature?: string; corrupt?: boolean } = {}
) => {
  const filename = "openteam-darwin-arm64";
  const compressed = gzipSync(raw);
  const origin = s.release(
    {
      [filename]: raw,
      [`${filename}.gz`]: compressed,
      ...(options.signature ? { [`${filename}.sigstore.json`]: options.signature } : {}),
    },
    `${options.corrupt ? "0".repeat(64) : digest(raw)}  apps/cli/release/${filename}\n` +
      `${digest(compressed)}  apps/cli/release/${filename}.gz\n`
  );
  return {
    assetUrl: `${origin}/${filename}`,
    checksumUrl: `${origin}/SHA256SUMS`,
    signatureUrl: `${origin}/${filename}.sigstore.json`,
  };
};

describe("CLI self-update", () => {
  test("removes a standalone Unix CLI without deleting a shared runtime", () => {
    const directory = s.dir("openteam-cli-remove-");
    const executable = join(directory, "openteam");
    writeFileSync(executable, "standalone executable", { mode: 0o755 });
    writeFileSync(`${executable}.previous`, "previous standalone executable", {
      mode: 0o755,
    });
    expect(
      removeCurrentCli({
        executable,
        argv: [executable, "/$bunfs/root/openteam", "uninstall"],
        versions: { bun: "1.3.8" },
        platform: "linux",
        standaloneExecutable: true,
      })
    ).toBe(executable);
    expect(existsSync(executable)).toBe(false);
    expect(existsSync(`${executable}.previous`)).toBe(false);

    const sharedRuntime = join(directory, "bun");
    writeFileSync(sharedRuntime, "shared runtime", { mode: 0o755 });
    expect(
      removeCurrentCli({
        executable: sharedRuntime,
        argv: [sharedRuntime, join(directory, "main.ts"), "uninstall"],
        versions: { bun: "1.3.8" },
        platform: "linux",
        standaloneExecutable: false,
      })
    ).toBeNull();
    expect(existsSync(sharedRuntime)).toBe(true);
  });

  test("verifies compressed and raw checksums plus the release Sigstore identity", async () => {
    const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
    const raw = new Uint8Array(readFileSync(fixture("release-v0.1.0/openteam-compose.yaml")));
    const signature = readFileSync(
      fixture("release-v0.1.0/openteam-compose.yaml.sigstore.json"),
      "utf8"
    );
    const release = artifactServer(raw, { signature });
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
    const release = artifactServer(new TextEncoder().encode("not trusted"), { corrupt: true });
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
    const directory = s.dir("openteam-cli-update-");
    const target = join(directory, "openteam");
    writeFileSync(target, "#!/bin/sh\necho 1.1.0\n", { mode: 0o755 });
    const nextContents = new TextEncoder().encode("#!/bin/sh\necho 1.2.3\n");
    const release = artifactServer(nextContents);
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
    const directory = s.dir("openteam-cli-update-windows-");
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
