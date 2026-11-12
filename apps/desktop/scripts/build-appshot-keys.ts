import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Builds the macOS helper that detects modifier chords (both Command keys) for appshots, as
 * a universal binary. Other platforms use Electron's globalShortcut and need no helper.
 */
const desktop = resolve(import.meta.dir, "..");
const source = resolve(desktop, "native/appshot-keys.swift");
const output = resolve(desktop, "dist-electron/appshot-keys");

if (process.platform !== "darwin") {
  console.log("appshot-keys: skipped (macOS only)");
  process.exit(0);
}
const current = await stat(output).catch(() => null);
const sourceTime = (await stat(source)).mtimeMs;
if (current && current.mtimeMs >= sourceTime && process.argv.includes("--if-stale")) process.exit(0);

await mkdir(resolve(desktop, "dist-electron"), { recursive: true });
const parts = ["arm64", "x86_64"].map((arch) => `${output}-${arch}`);
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command[0]} failed`);
};
await Promise.all(["arm64", "x86_64"].map((arch, index) =>
  run(["xcrun", "swiftc", "-O", "-target", `${arch}-apple-macos12.0`, source, "-o", parts[index]!])
));
await run(["lipo", "-create", ...parts, "-output", output]);
await Promise.all(parts.map((part) => rm(part, { force: true })));
console.log(`appshot-keys: built ${output}`);
