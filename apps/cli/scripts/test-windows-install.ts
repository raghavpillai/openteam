/** Native Windows bootstrap and ConPTY checks. Run on Windows with Python + pywinpty. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { powerShellInstallScript } from "../../landing/lib/install-script";

if (process.platform !== "win32") throw new Error("Run this suite on native Windows.");
const root = resolve(import.meta.dir, "../../..");
const output = resolve(root, "output/windows-install");
const assets = resolve(output, "assets");
mkdirSync(assets, { recursive: true });
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`);
}
for (const [entry, name] of [
  ["src/main.ts", "openteam-windows-x64.exe"],
  ["test/fixtures/setup-countdown.ts", "countdown.exe"],
  ["test/fixtures/windows-docker.ts", "docker.exe"],
]) {
  await run([
    process.execPath,
    "build",
    `apps/cli/${entry}`,
    "--compile",
    "--minify",
    "--target=bun-windows-x64-baseline",
    ...(process.env.OPENTEAM_TEST_BUN_EXECUTABLE
      ? [`--compile-executable-path=${process.env.OPENTEAM_TEST_BUN_EXECUTABLE}`]
      : []),
    `--outfile=${resolve(assets, name!)}`,
  ]);
}
const filename = "openteam-windows-x64.exe";
const binary = new Uint8Array(await Bun.file(resolve(assets, filename)).arrayBuffer());
await Bun.write(resolve(assets, `${filename}.gz`), Bun.gzipSync(binary));
await Bun.write(
  resolve(assets, "SHA256SUMS"),
  `${createHash("sha256").update(binary).digest("hex")}  ${filename}\n`
);
await Bun.write(resolve(assets, "bad-checksums"), `${"0".repeat(64)}  ${filename}\n`);
await Bun.write(resolve(output, "install.ps1"), powerShellInstallScript);
await run(["python", "apps/cli/test/fixtures/windows-install.py", output]);
