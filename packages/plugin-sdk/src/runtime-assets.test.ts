import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
function pax(key: string, value: string): string {
  const record = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length)
    length = String(length).length + Buffer.byteLength(record);
  return `${length}${record}`;
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

  test("omitted prerequisites need no network or cache directory", async () => {
    const { cache } = await fixture();
    const fetch = download();
    expect(await new ManagedRuntimeCache(cache, fetch).resolve(undefined)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(await Bun.file(join(cache, "anything")).exists()).toBe(false);
  });

  test("supports a cache directory reached through a symlinked parent, including macOS /var", async () => {
    const { root, cache } = await fixture();
    const alias = join(root, "alias");
    await symlink(root, alias);
    const environment = await new ManagedRuntimeCache(join(alias, "cache"), download()).resolve(assets(), undefined, platform);
    expect(await readFile(environment.OPENTEAM_RUNTIME_TOOL!)).toEqual(bytes);
    expect((await readdir(cache)).some((name) => name.startsWith(".runtime-"))).toBe(false);
  });

  test("selects the requested platform without downloading another platform's artifact", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const runtimes = assets();
    runtimes[0]!.sources["darwin-arm64"] = pin(bytes, { url: "https://runtime.example/darwin-tool" });
    await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, "darwin-arm64");
    expect(String(fetch.mock.calls[0]![0])).toBe("https://runtime.example/darwin-tool");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("rejects an unsupported platform without downloading anything", async () => {
    const { cache } = await fixture();
    const fetch = download();
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, "win32-x64"))
      .rejects.toThrow(/no managed runtime.*win32-x64/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("does not report success with an incomplete set of required platform assets", async () => {
    const { cache } = await fixture();
    const runtimes = [...assets(), { name: "JAVA", sources: { "darwin-arm64": pin() } }];
    await expect(new ManagedRuntimeCache(cache, download()).resolve(runtimes, undefined, platform)).rejects.toThrow(/platform|linux-arm64/);
  });

  test("allows an explicitly optional asset to be unavailable on the requested platform", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const runtimes = [...assets(), { name: "OPTIONAL", optional: true, sources: { "darwin-arm64": pin() } }];
    const result = await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform);
    expect(Object.keys(result)).toEqual(["OPENTEAM_RUNTIME_TOOL"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("all optional assets absent on this platform return an empty environment without creating the cache", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const runtimes: PluginRuntimeAsset[] = [
      { name: "OPTIONAL", optional: true, sources: { "darwin-arm64": pin() } },
      { name: "OTHER", optional: true, sources: { "linux-x64": pin() } },
    ];
    expect(await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("shares one pinned source between differently named assets without conflating their environment bindings", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const result = await new ManagedRuntimeCache(cache, fetch).resolve([...assets(), ...assets(pin(), "OTHER")], undefined, platform);
    expect(result.OPENTEAM_RUNTIME_TOOL).toBe(result.OPENTEAM_RUNTIME_OTHER);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["wrong SHA-256", { sha256: "0".repeat(64) }, bytes],
    ["truncated body", {}, bytes.subarray(0, bytes.length - 1)],
    ["body over pinned size", {}, Buffer.concat([bytes, Buffer.from("extra")])],
  ] as Array<[string, Partial<PluginRuntimeAssetSource>, Buffer]>)("rejects %s and removes staging files", async (_label, overrides, body) => {
    const { cache } = await fixture();
    await expect(new ManagedRuntimeCache(cache, download(body)).resolve(assets(pin(bytes, overrides)), undefined, platform))
      .rejects.toThrow(/SHA-256|size/);
    await emptyCache(cache);
  });

  test("enforces the pin across multiple streamed chunks without Content-Length", async () => {
    const { cache } = await fixture();
    const fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.enqueue(Buffer.from("extra")); controller.close(); },
    })));
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/exceeds/);
    await emptyCache(cache);
  });

  test("rejects a mismatched advertised length and cancels the response body", async () => {
    const { cache } = await fixture();
    const cancel = mock(() => {});
    const fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "Content-Length": String(bytes.length + 1) },
    }));
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow(/size/);
    expect(cancel).toHaveBeenCalledTimes(1);
    await emptyCache(cache);
  });

  test.each([404, 500])("rejects HTTP %i without installing a payload", async (status) => {
    const { cache } = await fixture();
    await expect(new ManagedRuntimeCache(cache, async () => new Response(bytes, { status }))
      .resolve(assets(), undefined, platform)).rejects.toThrow(String(status));
    await emptyCache(cache);
  });

  test.each([404, 503])("cancels an unread HTTP %i response body and permits a clean retry", async (status) => {
    const { cache } = await fixture();
    const cancel = mock(() => {});
    const fetch = mock(async () => fetch.mock.calls.length === 1
      ? new Response(new ReadableStream<Uint8Array>({ cancel }), { status })
      : new Response(bytes));
    const manager = new ManagedRuntimeCache(cache, fetch);
    await expect(manager.resolve(assets(), undefined, platform)).rejects.toThrow(String(status));
    expect(cancel).toHaveBeenCalledTimes(1);
    await emptyCache(cache);
    const environment = await manager.resolve(assets(), undefined, platform);
    expect(await readFile(environment.OPENTEAM_RUNTIME_TOOL!)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([false, true])("cancels the response after download open fails, preserves ENOSPC, and permits retry (cancel rejects: %s)", async (cancelRejects) => {
    const { cache } = await fixture();
    const failure = Object.assign(new Error("synthetic download open ENOSPC"), { code: "ENOSPC" });
    const cancel = mock(() => cancelRejects ? Promise.reject(new Error("synthetic cancel failure")) : undefined);
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = mock(async () => fetch.mock.calls.length === 1 ? new Response(body) : new Response(bytes));
    const originalOpen = filesystem.open;
    const open = spyOn(filesystem, "open");
    let failed = false;
    open.mockImplementation((async (...args: Parameters<typeof filesystem.open>) => {
      if (!failed && String(args[0]).startsWith(cache + "/") && String(args[0]).endsWith("/download")) {
        failed = true;
        throw failure;
      }
      return Reflect.apply(originalOpen, filesystem, args);
    }) as typeof filesystem.open);
    try {
      const manager = new ManagedRuntimeCache(cache, fetch);
      await expect(manager.resolve(assets(), undefined, platform)).rejects.toBe(failure);
      expect(failed).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      await emptyCache(cache);
      const environment = await manager.resolve(assets(), undefined, platform);
      expect(await readFile(environment.OPENTEAM_RUNTIME_TOOL!)).toEqual(bytes);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
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

  test("follows a relative HTTPS redirect and verifies the final payload", async () => {
    const { cache } = await fixture();
    const fetch = mock(async (_url: string | URL, options?: RequestInit) => {
      expect(options?.redirect).toBe("manual");
      return fetch.mock.calls.length === 1
        ? new Response(null, { status: 307, headers: { location: "/cdn/tool" } })
        : new Response(bytes);
    });
    await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    expect(String(fetch.mock.calls[1]![0])).toBe("https://runtime.example/cdn/tool");
  });

  test("bounds redirect loops and permits a later clean retry", async () => {
    const { cache } = await fixture();
    let redirect = true;
    const fetch = mock(async () => redirect
      ? new Response(null, { status: 302, headers: { location: "/tool" } }) : new Response(bytes));
    const manager = new ManagedRuntimeCache(cache, fetch);
    await expect(manager.resolve(assets(), undefined, platform)).rejects.toThrow(/too many/);
    expect(fetch).toHaveBeenCalledTimes(6);
    await emptyCache(cache);
    redirect = false;
    expect((await manager.resolve(assets(), undefined, platform)).OPENTEAM_RUNTIME_TOOL).toBeString();
  });
});

describe("managed runtime archive confinement", () => {
  test.each(["2", "1"])("accepts an in-tree %s link used as the runtime entry point", async (type) => {
    const { cache } = await fixture();
    const data = archive([
      { path: "lib/tool", body: bytes },
      { path: "bin/tool", type, link: type === "2" ? "../lib/tool" : "lib/tool" },
    ]);
    const environment = await new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform);
    expect(await readFile(environment.OPENTEAM_RUNTIME_TOOL!)).toEqual(bytes);
  });

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

  test.each([
    ["path", "../../escaped", "0"],
    ["linkpath", "../../escaped", "2"],
    ["linkpath", "../../escaped", "1"],
  ])("rejects traversal carried by PAX %s metadata targeting %s on entry type %s", async (field, value, type) => {
    const { cache } = await fixture();
    const data = archive([
      { path: "bin/tool", body: bytes },
      { path: "PaxHeader", type: "x", body: pax(field!, value!) },
      { path: "apparently-safe", type, ...(type === "0" ? { body: "escaped" } : { link: "bin/tool" }) },
    ]);
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow();
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

  test("enforces the archive entry limit even when every entry has zero payload bytes", async () => {
    const { cache } = await fixture();
    // Repeated root directory entries avoid creating thousands of fixture files.
    const data = archive(Array.from({ length: 20_001 }, () => ({ path: "./", type: "5" })));
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow(/extraction limits/);
    await emptyCache(cache);
  });

  test.each([
    { path: "other", body: bytes },
    { path: "bin/tool", type: "5" },
    { path: "bin/tool", type: "2", link: "missing" },
  ] as TarEntry[])("rejects a missing, directory, or dangling entry: %j", async (entry) => {
    const { cache } = await fixture();
    const data = archive([entry]);
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow();
    await emptyCache(cache);
  });

  test("rejects a corrupt archive even when its download digest is pinned correctly", async () => {
    const { cache } = await fixture();
    const data = Buffer.from("this is not a tar.gz archive");
    await expect(new ManagedRuntimeCache(cache, download(data)).resolve(assets(archivePin(data)), undefined, platform))
      .rejects.toThrow();
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

  test.each(["missing", "invalid JSON", "different archive pin"])("rejects a cache with %s metadata", async (kind) => {
    const { cache } = await fixture();
    const fetch = download();
    const result = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    const marker = join(dirname(dirname(result.OPENTEAM_RUNTIME_TOOL!)), ".runtime.json");
    if (kind === "missing") await rm(marker);
    else await writeFile(marker, kind === "invalid JSON" ? "{" : JSON.stringify({ archive: "0".repeat(64), entry: digest(bytes) }));
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("detects replacement of the entry point by a link outside the cached asset", async () => {
    const { root, cache } = await fixture();
    const fetch = download();
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    const path = environment.OPENTEAM_RUNTIME_TOOL!;
    const outside = join(root, "outside");
    await writeFile(outside, bytes);
    await rm(path);
    await symlink(outside, path);
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

  test("detects cached library tampering, not only modifications to the launcher", async () => {
    const { cache } = await fixture();
    const data = archive([{ path: "bin/tool", body: bytes }, { path: "lib/runtime.so", body: "original library" }]);
    const fetch = download(data);
    const runtimes = assets(archivePin(data));
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform);
    const installed = dirname(dirname(environment.OPENTEAM_RUNTIME_TOOL!));
    await writeFile(join(installed, "lib/runtime.so"), "modified library");
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform)).rejects.toThrow();
  });

  test.each(["__proto__", "constructor", "toString"])("inventories and verifies a support file named %s across cache instances", async (name) => {
    const { cache } = await fixture();
    const data = archive([{ path: "bin/tool", body: bytes }, { path: name, body: "trusted support data" }]);
    const fetch = download(data);
    const runtimes = assets(archivePin(data));
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform);
    const installed = dirname(dirname(environment.OPENTEAM_RUNTIME_TOOL!));
    const marker = JSON.parse(await readFile(join(installed, ".runtime.json"), "utf8"));
    expect(Object.hasOwn(marker.inventory, name)).toBe(true);
    expect(marker.inventory[name].sha256).toBe(digest("trusted support data"));
    expect(await new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform)).toEqual(environment);
    await writeFile(join(installed, name), "changed support data");
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(runtimes, undefined, platform)).rejects.toThrow(/verification/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not reuse an executable that has lost its executable permission", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const environment = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    await chmod(environment.OPENTEAM_RUNTIME_TOOL!, 0o600);
    // A resolved executable must either be repaired or rejected before connector startup.
    const next = await new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform).catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      return undefined;
    });
    if (next) {
      expect((await lstat(next.OPENTEAM_RUNTIME_TOOL!)).mode & 0o100).toBe(0o100);
    }
  });
});

describe("managed runtime cancellation and concurrent callers", () => {
  test("an already cancelled caller starts no download", async () => {
    const { cache } = await fixture();
    const fetch = download();
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);
    await expect(new ManagedRuntimeCache(cache, fetch).resolve(assets(), controller.signal, platform)).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

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

  test("aborts the underlying fetch when every waiting caller cancels", async () => {
    const { cache } = await fixture();
    const started = deferred<AbortSignal>();
    const observedAbort = deferred();
    const fetch = mock(async (_url: string | URL, options?: RequestInit): Promise<Response> => {
      const signal = options!.signal!;
      started.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        observedAbort.resolve(); reject(signal.reason);
      }, { once: true }));
    });
    const manager = new ManagedRuntimeCache(cache, fetch);
    const one = new AbortController(), two = new AbortController();
    const first = manager.resolve(assets(), one.signal, platform).catch((error) => error);
    const second = manager.resolve(assets(), two.signal, platform).catch((error) => error);
    const underlying = await started.promise;
    one.abort(new Error("one cancelled"));
    await first;
    expect(underlying.aborted).toBe(false);
    two.abort(new Error("two cancelled"));
    await second;
    await observedAbort.promise;
    expect(underlying.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("cancels a streaming download, cleans up, and permits retry after transport cleanup", async () => {
    const { cache } = await fixture();
    const waitingForBody = deferred();
    const controller = new AbortController();
    let requests = 0;
    const fetch = mock(async (_url: string | URL, options?: RequestInit) => {
      if (++requests > 1) return new Response(bytes);
      const signal = options!.signal!;
      return new Response(new ReadableStream<Uint8Array>({
        start(body) {
          body.enqueue(bytes.subarray(0, 5));
          signal.addEventListener("abort", () => body.error(signal.reason), { once: true });
        },
        pull() { waitingForBody.resolve(); },
      }));
    });
    const manager = new ManagedRuntimeCache(cache, fetch);
    const result = manager.resolve(assets(), controller.signal, platform).catch((error) => error);
    await waitingForBody.promise;
    const reason = new Error("cancel streaming");
    controller.abort(reason);
    expect(await result).toBe(reason);
    // Wait for observable cleanup, rather than depending on the caller's early rejection.
    for (let attempt = 0; attempt < 100 && (await readdir(cache)).length; attempt++) await Bun.sleep(1);
    await emptyCache(cache);
    expect((await manager.resolve(assets(), undefined, platform)).OPENTEAM_RUNTIME_TOOL).toBeString();
  });

  test("a new caller after all previous waiters cancelled gets a fresh download", async () => {
    const { cache } = await fixture();
    const started = deferred<AbortSignal>();
    const finishCancelledDownload = deferred<Response>();
    const fetch = mock(async (_url: string | URL, options?: RequestInit) => {
      if (fetch.mock.calls.length === 1) {
        started.resolve(options!.signal!);
        // Transport cleanup can finish after a new request arrives.
        return finishCancelledDownload.promise;
      }
      return new Response(bytes);
    });
    const manager = new ManagedRuntimeCache(cache, fetch);
    const controller = new AbortController();
    const first = manager.resolve(assets(), controller.signal, platform).catch((error) => error);
    const underlying = await started.promise;
    controller.abort(new Error("cancelled"));
    await first;
    expect(underlying.aborted).toBe(true);
    const retry = manager.resolve(assets(), undefined, platform);
    finishCancelledDownload.reject(underlying.reason);
    expect((await retry).OPENTEAM_RUNTIME_TOOL).toBeString();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("separate cache instances racing for one destination both return a complete verified payload", async () => {
    const { cache } = await fixture();
    const firstStarted = deferred(), secondStarted = deferred(), release = deferred();
    let requests = 0;
    const fetch = mock(async () => {
      (++requests === 1 ? firstStarted : secondStarted).resolve();
      await release.promise;
      return new Response(bytes);
    });
    const first = new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    await firstStarted.promise;
    const second = new ManagedRuntimeCache(cache, fetch).resolve(assets(), undefined, platform);
    await secondStarted.promise;
    release.resolve();
    const paths = await Promise.all([first, second]);
    expect(paths[0]).toEqual(paths[1]);
    expect(await readFile(paths[0]!.OPENTEAM_RUNTIME_TOOL!)).toEqual(bytes);
    expect(await readdir(cache)).toHaveLength(1);
  });
});
