import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Files Chromium cannot safely share while several profile owners are live.
 * They are promoted into one computer-scoped snapshot only after a browser has
 * stopped, then hydrated into the next browser before it starts. Origin data
 * that needs live propagation is handled separately by BrowserBroker.
 */
export const PORTABLE_PROFILE_ENTRIES = [
  "Local State",
  "Default/Preferences",
  "Default/Secure Preferences",
  "Default/Bookmarks",
  "Default/Bookmarks.bak",
  "Default/History",
  "Default/History Provider Cache",
  "Default/Session Storage",
  "Default/Login Data",
  "Default/Login Data For Account",
  "Default/Web Data",
  "Default/Web Data For Account",
  "Default/Extensions",
  "Default/Extension Rules",
  "Default/Extension State",
  "Default/Local Extension Settings",
  "Default/Managed Extension Settings",
  "Default/Sync Extension Settings",
  "Default/Sessions",
] as const;

interface ProfileAuthorityManifest {
  version: 1;
  publishedAt: string;
  sourceProfile: string;
  entries: string[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    return Boolean(await lstat(path));
  } catch {
    return false;
  }
};

export class BrowserProfileAuthority {
  private readonly root: string;
  private readonly current: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly home: string) {
    this.root = join(home, ".openteam", "browser-profile-authority");
    this.current = join(this.root, "current");
  }

  prepare(profileDirectory: string): Promise<void> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return;
      for (const relative of manifest.entries) {
        const source = join(this.current, "profile", relative);
        if (!(await exists(source))) continue;
        const target = join(profileDirectory, relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rm(target, { recursive: true, force: true });
        await cp(source, target, { recursive: true, preserveTimestamps: true });
      }
    });
  }

  publish(profileDirectory: string): Promise<void> {
    return this.enqueue(() => this.publishNow(profileDirectory));
  }

  /**
   * Bootstrap an authority from a pre-authority profile without allowing an
   * older dormant profile to overwrite an already canonical snapshot.
   */
  seedIfEmpty(profileDirectory: string): Promise<void> {
    return this.enqueue(async () => {
      if (await this.readManifest()) return;
      await this.publishNow(profileDirectory);
    });
  }

  clientCertificateStore(): string {
    // Chromium on Linux uses the user's NSS database. Every bot browser runs
    // as the same computer user, so client certificates are already shared.
    return join(this.home, ".pki", "nssdb");
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async publishNow(profileDirectory: string): Promise<void> {
    if (!(await exists(profileDirectory))) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = join(this.root, `.staging-${randomUUID()}`);
    const previous = join(this.root, `.previous-${randomUUID()}`);
    const entries: string[] = [];
    try {
      for (const relative of PORTABLE_PROFILE_ENTRIES) {
        const source = join(profileDirectory, relative);
        if (!(await exists(source))) continue;
        const target = join(staging, "profile", relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(source, target, { recursive: true, preserveTimestamps: true });
        entries.push(relative);
      }
      if (entries.length === 0) return;
      const manifest: ProfileAuthorityManifest = {
        version: 1,
        publishedAt: new Date().toISOString(),
        sourceProfile: profileDirectory,
        entries,
      };
      await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      if (await exists(this.current)) await rename(this.current, previous);
      await rename(staging, this.current);
      await rm(previous, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async readManifest(): Promise<ProfileAuthorityManifest | null> {
    try {
      const value = JSON.parse(await readFile(join(this.current, "manifest.json"), "utf8")) as {
        version?: unknown;
        publishedAt?: unknown;
        sourceProfile?: unknown;
        entries?: unknown;
      };
      if (
        value.version !== 1 ||
        typeof value.publishedAt !== "string" ||
        typeof value.sourceProfile !== "string" ||
        !Array.isArray(value.entries) ||
        value.entries.some(
          (entry) =>
            typeof entry !== "string" ||
            entry.startsWith("/") ||
            entry.split("/").some((part) => !part || part === "." || part === "..")
        )
      ) {
        return null;
      }
      return value as ProfileAuthorityManifest;
    } catch {
      return null;
    }
  }
}
