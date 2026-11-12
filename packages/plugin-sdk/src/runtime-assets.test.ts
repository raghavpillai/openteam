import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { ManagedRuntimeCache } from "./runtime-assets";
import type { PluginRuntimeAsset, PluginRuntimeAssetSource } from "./types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openteam-runtime-test-")));
  roots.push(root);
  const cache = join(root, "cache");
  return { root, cache };
}
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const platform = "linux-arm64";
const bytes = Buffer.from("#!/bin/sh\nprintf runtime-fixture\\n\n");
function pin(data: Buffer = bytes, overrides: Partial<PluginRuntimeAssetSource> = {}): PluginRuntimeAssetSource {
  return {
    url: "https://runtime.example/tool", sha256: digest(data), bytes: data.length,
    maxExtractedBytes: 1024 * 1024, format: "file", path: "bin/tool", executable: true,
    ...overrides,
  };
}
function assets(source = pin(), name = "TOOL"): PluginRuntimeAsset[] {
  return [{ name, sources: { [platform]: source } }];
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function emptyCache(cache: string) {
  expect(await readdir(cache).catch(() => [])).toEqual([]);
}
const download = (data: Buffer = bytes) => mock(async (_url: string | URL, _options?: RequestInit) => new Response(new Uint8Array(data)));

type TarEntry = { path: string; body?: string | Buffer; type?: string; link?: string };
/** Write USTAR bytes directly: archive libraries commonly sanitize the malicious fixtures under test. */
function archive(entries: TarEntry[]): Buffer {
  const records: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.body ?? "");
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000700\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write(entry.link ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    records.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}
const archivePin = (data: Buffer, overrides: Partial<PluginRuntimeAssetSource> = {}) =>
  pin(data, { format: "tar.gz", ...overrides });

describe("managed runtime downloads and pins", () => {
  test("installs a raw executable, creates private files, and reuses verified bytes across cache instances", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const runtimes = assets();
    const first = await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform);
    const path = first.OPENTEAM_RUNTIME_TOOL!;
    expect(await readFile(path)).toEqual(bytes);
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
    expect((await lstat(cache)).mode & 0o777).toBe(0o700);
    const second = await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await readdir(cache)).some((name) => name.startsWith(".runtime-"))).toBe(false);
  });

  test("enforces the pin across multiple streamed chunks without Content-Length", async () => {
    const { cache } = await fixture();
    const fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.enqueue(Buffer.from("extra")); controller.close(); },
    })));
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/exceeds/);
    await emptyCache(cache);
  });

  test.each(["http://runtime.example/tool", "https://user:password@runtime.example/tool"])(
    "rejects unsafe redirects before sending a second request: %s", async (location) => {
      const { cache } = await fixture();
      const fetch = mock(async () => new Response(null, { status: 302, headers: { location } }));
      await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/redirect/);
      expect(fetch).toHaveBeenCalledTimes(1);
      await emptyCache(cache);
    },
  );

});

describe("managed runtime archive confinement", () => {

  const unsafe: Array<[string, TarEntry]> = [
    ["parent path", { path: "../escaped", body: "escaped" }],
    ["nested traversal", { path: "safe/../../escaped", body: "escaped" }],
    ["absolute path", { path: "/escaped", body: "escaped" }],
    ["Windows separators", { path: "safe\\escaped", body: "escaped" }],
    ["control characters", { path: "safe/esc\naped", body: "escaped" }],
    ["escaping symlink", { path: "escape", type: "2", link: "../../escaped" }],
    ["absolute symlink", { path: "escape", type: "2", link: "/escaped" }],
    ["escaping hardlink", { path: "escape", type: "1", link: "../../escaped" }],
    ["absolute hardlink", { path: "escape", type: "1", link: "/escaped" }],
    ["FIFO", { path: "pipe", type: "6" }],
    ["character device", { path: "device", type: "3" }],
  ];
  test.each(unsafe)("rejects the whole archive containing %s, even alongside a valid entry", async (_label, malicious) => {
    const { root, cache } = await fixture();
    const data = archive([{ path: "bin/tool", body: bytes }, malicious]);
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow();
    await emptyCache(cache);
    expect(await Bun.file(join(root, "escaped")).exists()).toBe(false);
  });

  test("rejects writes through a symlink pivot without modifying the sibling file", async () => {
    const { root, cache } = await fixture();
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "untouched");
    const data = archive([
      { path: "bin/tool", body: bytes },
      { path: "pivot", type: "2", link: "../../.." },
      { path: "pivot/sentinel", body: "overwritten" },
    ]);
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    await emptyCache(cache);
  });

  test("enforces the cumulative expanded size instead of just compressed download size", async () => {
    const { cache } = await fixture();
    const data = archive([{ path: "bin/tool", body: Buffer.alloc(64 * 1024, 65) }]);
    await expect(new ManagedRuntimeCache(cache, download(data))
      .resolve(assets(archivePin(data, { maxExtractedBytes: data.length + 100 })), undefined, platform))
      .rejects.toThrow(/extraction limits/);
    await emptyCache(cache);
  });

});

describe("managed runtime cache integrity", () => {
  test("detects cached executable tampering across cache instances without redownloading", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    await writeFile(environment.OPENTEAM_RUNTIME_TOOL!, "modified executable");
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/verification/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the cache directory is replaced with a symlink", async () => {
    const { root, cache } = await fixture();
    const fetch = download();
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    const installed = dirname(dirname(environment.OPENTEAM_RUNTIME_TOOL!));
    const outside = join(root, "replacement");
    await mkdir(outside);
    await rm(installed, { recursive: true });
    await symlink(outside, installed);
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/cache directory/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});

describe("managed runtime cancellation and concurrent callers", () => {
  test("deduplicates downloads while letting one caller cancel without aborting another", async () => {
    const { cache } = await fixture();
    const started = deferred<AbortSignal>();
    const release = deferred<Response>();
    const fetch = mock(async (_url: string | URL, options?: RequestInit) => {
      started.resolve(options!.signal!);
      return release.promise;
    });
    const manager = new ManagedRuntimeCache(cache, fetch);
    const controller = new AbortController();
    const reason = new Error("first caller cancelled");
    const first = manager.resolve(assets(), controller.signal, platform).catch((error) => error);
    const second = manager.resolve(assets(), undefined, platform);
    const underlying = await started.promise;
    controller.abort(reason);
    expect(await first).toBe(reason);
    expect(underlying.aborted).toBe(false);
    release.resolve(new Response(bytes));
    expect((await second).OPENTEAM_RUNTIME_TOOL).toBeString();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});
