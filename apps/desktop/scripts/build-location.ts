import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("location: skipped (macOS only)");
  process.exit(0);
}
const desktop = resolve(import.meta.dir, "..");
const output = resolve(desktop, "dist-electron/location.node");
const require = createRequire(import.meta.url);
const headers = resolve(dirname(require.resolve("node-api-headers/package.json")), "include");
await mkdir(dirname(output), { recursive: true });
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command[0]} failed`);
};
const parts = ["arm64", "x86_64"].map((arch) => `${output}-${arch}`);
await Promise.all(["arm64", "x86_64"].map((arch, index) => run([
  "xcrun", "clang", "-O2", "-fobjc-arc", "-shared", "-undefined", "dynamic_lookup",
  "-arch", arch, "-mmacosx-version-min=12.0", "-DNAPI_VERSION=8", "-I", headers,
  "-framework", "Foundation", "-framework", "CoreLocation",
  resolve(desktop, "native/location.m"), "-o", parts[index]!,
])));
await run(["lipo", "-create", ...parts, "-output", output]);
await Promise.all(parts.map((part) => rm(part, { force: true })));
console.log(`location: built ${output}`);
