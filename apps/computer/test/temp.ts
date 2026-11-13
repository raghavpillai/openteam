// Temporary directories for one test file, removed after its tests and their own cleanup hooks have run.
import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Call once at the top level of a test file (Bun shares imported modules across files). */
export function tempDirs() {
  const created: string[] = [];
  afterAll(() => Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
  return async (prefix = "openteam-test-") => {
    const path = await mkdtemp(join(tmpdir(), prefix));
    created.push(path);
    return path;
  };
}
