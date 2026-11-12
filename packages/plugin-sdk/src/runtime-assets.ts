import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { x as extract } from "tar";
import { validateRuntimeAssets } from "./runtime-asset-definition";
import type { PluginRuntimeAsset, PluginRuntimeAssetSource } from "./types";

type Download = (url: string | URL, options?: RequestInit) => Promise<Response>;
type Pending = {
  promise: Promise<string>;
  abort: AbortController;
  users: number;
  settled: boolean;
};

/** Content-addressed prerequisites are shared across accounts and contain no account state. */
export class ManagedRuntimeCache {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly directory: string,
    private readonly download: Download = fetch
  ) {
    this.directory = resolve(directory);
  }

  async resolve(
    assets: PluginRuntimeAsset[] | undefined,
    signal?: AbortSignal,
    platform = `${process.platform}-${process.arch}`
  ): Promise<Record<string, string>> {
    validateRuntimeAssets(assets);
    if (!assets) return {};
    for (const asset of assets)
      if (!asset.sources[platform] && !asset.optional)
        throw new Error(
          `This plugin has no managed runtime for ${platform}: missing ${asset.name}`
        );
    const environment: Record<string, string> = {};
    for (const asset of assets) {
      signal?.throwIfAborted();
      const source = asset.sources[platform];
      if (!source && !asset.optional)
        throw new Error(
          `This plugin requires ${asset.name}, which has no managed runtime for ${platform}`
        );
      if (source)
        environment[`OPENTEAM_RUNTIME_${asset.name}`] = await this.acquire(source, signal);
    }
    return environment;
  }

  private acquire(source: PluginRuntimeAssetSource, signal?: AbortSignal): Promise<string> {
    const key = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    let pending = this.pending.get(key);
    if (pending?.abort.signal.aborted) {
      this.pending.delete(key);
      pending = undefined;
    }
    if (!pending) {
      const record: Pending = {
        promise: undefined!,
        abort: new AbortController(),
        users: 0,
        settled: false,
      };
      record.promise = this.install(key, source, record.abort.signal).finally(() => {
        record.settled = true;
        if (this.pending.get(key) === record) this.pending.delete(key);
      });
      void record.promise.catch(() => {});
      this.pending.set(key, record);
      pending = record;
    }
    const entry = pending;
    entry.users++;
    return new Promise<string>((resolve, reject) => {
      const cancel = () => reject(signal?.reason ?? new Error("Runtime installation cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      void entry.promise
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", cancel));
    }).finally(() => {
      entry.users--;
      if (!entry.users && !entry.settled)
        entry.abort.abort(new Error("Runtime installation cancelled"));
    });
  }

  private async verified(
    root: string,
    source: PluginRuntimeAssetSource
  ): Promise<string | undefined> {
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error("Invalid runtime cache directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const marker = JSON.parse(await readFile(join(root, ".runtime.json"), "utf8"));
    const executable = join(root, source.path);
    const actual = await realpath(executable);
    if (
      !actual.startsWith(root + sep) ||
      !(await lstat(actual)).isFile() ||
      marker.archive !== source.sha256 ||
      marker.entry !== (await this.hashFile(actual))
    )
      throw new Error(
        "Managed runtime cache verification failed. Reinstall this runtime before connecting."
      );
    if (source.executable && !((await lstat(actual)).mode & 0o111))
      throw new Error("Managed runtime executable permission is missing");
    if (
      JSON.stringify(marker.inventory) !==
      JSON.stringify(await this.inventory(root, source.maxExtractedBytes))
    )
      throw new Error("Managed runtime cache contents failed verification");
    return executable;
  }

  private async inventory(root: string, maximum: number) {
    const entries: Record<string, unknown> = Object.create(null);
    let count = 0,
      size = 0;
    const visit = async (relative = "") => {
      const names = (await readdir(join(root, relative))).sort();
      for (const name of names) {
        if (!relative && name === ".runtime.json") continue;
        const path = relative ? `${relative}/${name}` : name;
        const absolute = join(root, path);
        const stat = await lstat(absolute);
        if (++count > 20_000 || (size += stat.isFile() ? stat.size : 0) > maximum)
          throw new Error("Managed runtime cache exceeds its limits");
        if (stat.isSymbolicLink()) {
          const resolved = await realpath(absolute);
          if (resolved !== root && !resolved.startsWith(root + sep))
            throw new Error("Managed runtime link escapes its cache");
          entries[path] = { link: await readlink(absolute) };
        } else if (stat.isDirectory()) {
          entries[path] = { directory: true };
          await visit(path);
        } else if (stat.isFile())
          entries[path] = { sha256: await this.hashFile(absolute), executable: stat.mode & 0o111 };
        else throw new Error("Invalid managed runtime cache entry");
      }
    };
    await visit();
    return entries;
  }

  private async hashFile(path: string) {
    const hash = createHash("sha256");
    const reader = Bun.file(path).stream().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hash.update(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return hash.digest("hex");
  }

  private async fetchAsset(
    source: PluginRuntimeAssetSource,
    destination: string,
    signal: AbortSignal
  ) {
    let url = new URL(source.url);
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 5; redirect++) {
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid runtime download redirect");
      response = await this.download(url, { signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirect === 5)
        throw new Error("Runtime download redirected too many times");
      url = new URL(location, url);
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel().catch(() => {});
      throw new Error(`Runtime download failed (${response?.status ?? "no response"})`);
    }
    const advertised = response.headers.get("content-length");
    if (advertised && Number(advertised) !== source.bytes) {
      await response.body.cancel();
      throw new Error("Runtime download size differs from its pin");
    }
    const handle = await open(destination, "wx", 0o600).catch(async error => {
      await response!.body!.cancel().catch(() => {});
      throw error;
    });
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > source.bytes) throw new Error("Runtime download exceeds its pinned size");
        hash.update(chunk.value);
        await handle.writeFile(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      await handle.close();
    }
    if (size !== source.bytes || hash.digest("hex") !== source.sha256)
      throw new Error("Runtime download failed SHA-256 or size verification");
  }

  private async install(key: string, source: PluginRuntimeAssetSource, cancellation: AbortSignal) {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(300_000)]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(this.directory);
    await this.pruneStaging(directory);
    const destination = join(directory, key);
    const cached = await this.verified(destination, source);
    if (cached) return cached;
    const temporary = await mkdtemp(join(directory, ".runtime-"));
    try {
      const archive = join(temporary, "download");
      await this.fetchAsset(source, archive, signal);
      signal.throwIfAborted();
      const payload = join(temporary, "payload");
      await mkdir(payload, { mode: 0o700 });
      if (source.format === "file") {
        await mkdir(dirname(join(payload, source.path)), { recursive: true, mode: 0o700 });
        await rename(archive, join(payload, source.path));
      } else {
        let size = 0,
          entries = 0;
        let invalid = false;
        await extract({
          file: archive,
          cwd: payload,
          strict: true,
          preservePaths: false,
          preserveOwner: false,
          umask: 0o077,
          noMtime: true,
          filter: (name, raw) => {
            const entry = raw as import("tar").ReadEntry;
            const path = name.replace(/^\.\//, "").replace(/\/+$/, "");
            const target =
              entry.type === "SymbolicLink"
                ? posix.join(posix.dirname(path), entry.linkpath ?? "")
                : entry.linkpath;
            size += entry.size ?? 0;
            entries++;
            const safe =
              (!path ||
                path === "." ||
                (!path.startsWith("/") &&
                  !/[\\\x00-\x1f]/.test(path) &&
                  !path.split("/").includes(".."))) &&
              ["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type) &&
              (!entry.linkpath ||
                (!entry.linkpath.startsWith("/") && !/[\\\x00-\x1f]/.test(entry.linkpath))) &&
              (!target ||
                (!target.startsWith("/") &&
                  !/[\\\x00-\x1f]/.test(target) &&
                  !posix.normalize(target).startsWith(".."))) &&
              size <= source.maxExtractedBytes &&
              entries <= 20_000 &&
              !signal.aborted;
            invalid ||= !safe;
            return safe && !invalid;
          },
        });
        if (invalid)
          throw new Error("Runtime archive contains unsafe entries or exceeds extraction limits");
      }
      signal.throwIfAborted();
      const entry = await realpath(join(payload, source.path));
      if (!entry.startsWith(payload + sep) || !(await lstat(entry)).isFile())
        throw new Error("Runtime entry point is outside its asset directory");
      if (source.executable) await chmod(entry, 0o700);
      await writeFile(
        join(payload, ".runtime.json"),
        JSON.stringify({
          archive: source.sha256,
          entry: await this.hashFile(entry),
          inventory: await this.inventory(payload, source.maxExtractedBytes),
        }),
        { mode: 0o600, flag: "wx" }
      );
      signal.throwIfAborted();
      try {
        await rename(payload, destination);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      return (await this.verified(destination, source))!;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async pruneStaging(directory: string) {
    // Installs time out after five minutes. Leave recent staging alone across
    // processes; reclaim abandoned partial downloads after a full day.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await readdir(directory)) {
      if (!/^\.runtime-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const entry = await lstat(path);
        if (entry.isDirectory() && entry.mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
      } catch {
        // Cleanup is best effort and must not prevent a verified cache hit.
      }
    }
  }
}
