import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");

// Keep this allow-list explicit: these are generated build directories, never
// user data or a caller-provided path.
await Promise.all(
  ["dist", "dist-electron"].map((directory) =>
    rm(resolve(desktopRoot, directory), { force: true, recursive: true })
  )
);
