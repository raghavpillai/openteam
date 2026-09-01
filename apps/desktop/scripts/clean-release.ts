import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const requestedOutput = Bun.argv[2] ?? "release";
if (requestedOutput !== "release" && requestedOutput !== "release-local") {
  throw new Error(`Refusing to clean unsupported release output: ${requestedOutput}`);
}
const releaseRoot = resolve(desktopRoot, requestedOutput);

if (dirname(releaseRoot) !== desktopRoot || basename(releaseRoot) !== requestedOutput) {
  throw new Error(`Refusing to clean unexpected release path: ${releaseRoot}`);
}

// These are electron-builder's two generated output trees. Removing the whole
// selected tree prevents stale application or archive contents from passing validation.
await rm(releaseRoot, { force: true, recursive: true });
