import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const watchedRoots = ["agents", "user-memory", "projects", "workflows", "managed-skills", "plugin-skills"];

/** Metadata only: never read memory contents or descend into runtime/attachment stores. */
export async function snapshotWatchedFiles(
  root: string,
  ignored: (path: string) => boolean
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".part") || entry.name === "attachments") continue;
      const path = join(directory, entry.name);
      if (ignored(path)) continue;
      try {
        const stats = await lstat(path);
        if (stats.isDirectory()) {
          files.set(path, "directory");
          await visit(path);
        } else {
          // lstat records replacements without following symlinks outside the store.
          files.set(path, `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  for (const name of watchedRoots) await visit(join(root, name));
  return files;
}
