import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "..");
const outputDirectory = resolve(cliRoot, "release");
const entrypoint = resolve(cliRoot, "src/main.ts");

const targets = [
  ["bun-darwin-arm64", "openteam-darwin-arm64"],
  ["bun-darwin-x64", "openteam-darwin-x64"],
  ["bun-linux-arm64", "openteam-linux-arm64"],
  ["bun-linux-x64-baseline", "openteam-linux-x64"],
  ["bun-windows-x64-baseline", "openteam-windows-x64.exe"],
] as const;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [target, filename] of targets) {
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      "--minify",
      `--target=${target}`,
      `--outfile=${resolve(outputDirectory, filename)}`,
    ],
    { cwd: cliRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Failed to build ${target} (exit ${exitCode})`);
  // The install scripts download the gzip copy when it exists and verify the decompressed
  // binary against the raw binary's SHA256SUMS entry, so both files ship in the release.
  const binaryPath = resolve(outputDirectory, filename);
  const compressed = Bun.gzipSync(new Uint8Array(await Bun.file(binaryPath).arrayBuffer()), {
    level: 9,
  });
  await Bun.write(`${binaryPath}.gz`, compressed);
}
