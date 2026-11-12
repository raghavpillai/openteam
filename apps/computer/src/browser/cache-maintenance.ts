import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const CACHE_DIRECTORIES = ["Cache", "Code Cache", "GPUCache"] as const;

const plainDirectory = (path: string): boolean => {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === resolve(path);
};

const plainTree = (path: string): boolean => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) return stat.nlink === 1;
  if (!stat.isDirectory()) return false;
  return readdirSync(path).every((entry) => plainTree(join(path, entry)));
};

/**
 * Called synchronously before another browser can launch, after an owned browser
 * exited normally. Forced/unknown exits and remaining singleton markers skip all
 * cleanup. This is deliberately not a generic recursive "cache" name search.
 */
export const clearStoppedBrowserCaches = (
  profileDirectory: string,
  browser: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined
): string[] => {
  if (!browser || browser.exitCode !== 0 || browser.signalCode !== null) return [];
  const removed: string[] = [];
  try {
    if (!plainDirectory(profileDirectory)) return [];
    for (const marker of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        lstatSync(join(profileDirectory, marker));
        return [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
      }
    }
    const profiles = readdirSync(profileDirectory).filter(
      (name) => name === "Default" || /^Profile \d+$/.test(name)
    );
    for (const directory of [
      profileDirectory,
      ...profiles.map((name) => join(profileDirectory, name)),
    ]) {
      if (!plainDirectory(directory)) continue;
      for (const name of CACHE_DIRECTORIES) {
        const path = join(directory, name);
        if (!existsSync(path) || !plainDirectory(path) || !plainTree(path)) continue;
        rmSync(path, { recursive: true });
        removed.push(path);
      }
    }
  } catch (error) {
    console.warn(
      `Browser cache maintenance skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return removed;
};
