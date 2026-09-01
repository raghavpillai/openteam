import { resolve } from "node:path";
import { macosReleaseBuilderArgs, resolveMacosReleaseEnvironment } from "./macos-release-utils";

const desktopRoot = resolve(import.meta.dir, "..");
const builder = resolve(desktopRoot, "node_modules", ".bin", "electron-builder");
const release = resolveMacosReleaseEnvironment(process.env);

console.log(`Building a Developer ID macOS release with ${release.notarizationMode} notarization.`);
const child = Bun.spawn([builder, ...macosReleaseBuilderArgs(release.identity)], {
  cwd: desktopRoot,
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) {
  throw new Error(`electron-builder failed with exit code ${exitCode}`);
}
