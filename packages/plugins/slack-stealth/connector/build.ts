import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { scopedProcessEnvironment } from "@openteam/plugin-sdk";

const root = join(import.meta.dir, "..");
const toolchain = "go1.25.9";
const image = "golang:1.25.9-bookworm@sha256:298734aec230b5f3e8cee450ce6d7eccc39f1797ba548ee90d57e9803030c6c3";
const timestamp = "2026-05-14T22:46:32Z";
const targets = { "linux-x64": "amd64", "linux-arm64": "arm64" } as const;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export async function buildNativeServer(force = false) {
  const upstream = await Bun.file(join(root, "upstream.json")).json();
  // Refuse to compile modified vendored code under the original source identity.
  for (const [path, expected] of Object.entries(upstream.files)) {
    if (sha256(await readFile(join(root, "upstream", path))) !== expected)
      throw new Error(`Slack upstream source differs from its pinned digest: ${path}`);
  }
  const sourceDigest = sha256(JSON.stringify(Object.entries(upstream.files).sort()));
  const current = await Bun.file(join(import.meta.dir, "release.json")).json();
  const module = `github.com/${upstream.repository}/pkg/version`;
  const flags = ["-trimpath", "-buildvcs=false", "-mod=readonly", "-ldflags",
    `-s -w -X ${module}.CommitHash=${upstream.revision} -X ${module}.Version=${current.version} -X ${module}.BuildTime=${timestamp} -X ${module}.BinaryName=slack-mcp-server`];
  if (!force && current.build?.sourceDigest === sourceDigest && current.build?.toolchain === toolchain
    && current.build?.timestamp === timestamp && JSON.stringify(current.build?.flags) === JSON.stringify(flags)) {
    let valid = true;
    for (const target of Object.keys(targets)) {
      const binary = current.binaries[target];
      try {
        valid &&= !!binary && sha256(await readFile(join(root, binary.path))) === binary.gzipSha256;
      } catch { valid = false; }
    }
    if (valid) return;
  }
  const output = await mkdtemp(join(tmpdir(), "slack-source-build-"));
  const run = async (args: string[], env = scopedProcessEnvironment(process.env)) => {
    const child = Bun.spawn(args, { cwd: join(root, "upstream"), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Slack source build failed (${code}): ${stderr || stdout}`);
    return stdout.trim();
  };
  try {
    console.log("Compiling attributed Slack MCP source for Linux x64 and arm64...");
    const go = Bun.which("go");
    const matchingGo = go && (await run([go, "version"])).startsWith(`go version ${toolchain} `);
    if (matchingGo) {
      for (const [target, architecture] of Object.entries(targets)) {
        await run([go, "build", ...flags, "-o", join(output, target), "./cmd/slack-mcp-server"],
          scopedProcessEnvironment(process.env, { GOOS: "linux", GOARCH: architecture, CGO_ENABLED: "0", GOTOOLCHAIN: "local" }));
      }
    } else {
      const docker = Bun.which("docker");
      if (!docker) throw new Error(`Slack source packaging requires ${toolchain} or Docker. Installed plugins require neither.`);
      // One container shares module/compiler caches between both cross-compilations.
      const command = `for slack_arch in amd64 arm64; do GOARCH="$slack_arch" go build ${flags.slice(0, 3).join(" ")} -ldflags '${flags[4]}' -o "/out/linux-$slack_arch" ./cmd/slack-mcp-server; done`;
      await run([docker, "run", "--rm", "--mount", `type=bind,src=${join(root, "upstream")},dst=/src,readonly`,
        "--mount", `type=bind,src=${output},dst=/out`, "--workdir", "/src",
        "--env", "GOOS=linux", "--env", "CGO_ENABLED=0", "--env", "GOTOOLCHAIN=local", image, "sh", "-ec", command]);
    }
    const binaries: Record<string, { path: string; sha256: string; size: number; gzipSha256: string; gzipSize: number }> = {};
    await mkdir(join(import.meta.dir, "bin"), { recursive: true });
    for (const [target, architecture] of Object.entries(targets)) {
      const bytes = await readFile(join(output, matchingGo ? target : `linux-${architecture}`));
      const archive = gzipSync(bytes, { level: 9 });
      const path = `connector/bin/${target}.gz`;
      await writeFile(join(root, path), archive);
      binaries[target] = { path, sha256: sha256(bytes), size: bytes.length, gzipSha256: sha256(archive), gzipSize: archive.length };
    }
    await writeFile(join(import.meta.dir, "release.json"), JSON.stringify({
      repository: upstream.repository, version: current.version, revision: upstream.revision,
      build: { toolchain, sourceDigest, timestamp, flags }, binaries,
    }, null, 2) + "\n");
    console.log("Built and verified Slack MCP executables from vendored source.");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildNativeServer(process.argv.includes("--force"));
