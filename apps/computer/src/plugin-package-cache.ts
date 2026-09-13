import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  objectValue,
  safePackagePath,
  substituteConfiguration,
  validatePackageFiles,
} from "@openteam/plugin-sdk";

/** Versioned executable assets contain package files only; connection secrets stay in memory. */
export class PluginPackageCache {
  private readonly roots = new Map<string, Promise<string>>();
  constructor(private readonly directory: string) {}

  async resolve(input: unknown): Promise<unknown> {
    const { packageFiles, packageBinaryFiles, ...configuration } = objectValue(input);
    const files = objectValue(packageFiles) as Record<string, string>;
    const binaryFiles = objectValue(packageBinaryFiles) as Record<string, string>;
    if (!Object.keys(files).length && !Object.keys(binaryFiles).length) return configuration;
    validatePackageFiles(files);
    validatePackageFiles(binaryFiles);
    const digest = createHash("sha256")
      .update(JSON.stringify([files, binaryFiles]))
      .digest("hex");
    let root = this.roots.get(digest);
    if (!root) {
      root = this.materialize(digest, files, binaryFiles);
      this.roots.set(digest, root);
      root.catch(() => this.roots.delete(digest));
    }
    return substituteConfiguration(configuration, { PLUGIN_ROOT: await root });
  }

  private async materialize(
    digest: string,
    files: Record<string, string>,
    binaryFiles: Record<string, string>
  ): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(this.directory, ".install-"));
    const destination = join(this.directory, digest);
    try {
      for (const [path, content] of Object.entries({ ...files, ...binaryFiles })) {
        const target = join(temporary, safePackagePath(path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, path in binaryFiles ? Buffer.from(content, "base64") : content, {
          mode: 0o600,
          flag: "wx",
        });
      }
      // Replace an old on-disk cache on process restart; never follow its symlinks.
      await rm(destination, { recursive: true, force: true });
      await rename(temporary, destination);
      return destination;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
