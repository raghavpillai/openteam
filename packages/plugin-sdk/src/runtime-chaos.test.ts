import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntimeCache } from "./runtime-assets";
import type { PluginRuntimeAsset } from "./types";

// Synthetic prerequisites only: no executable runs and no network requests.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const data = Buffer.from("synthetic managed runtime\n".repeat(256));
const assets: PluginRuntimeAsset[] = [
  {
    name: "CHAOS",
    sources: {
      "linux-arm64": {
        url: "https://synthetic.invalid/runtime",
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
        maxExtractedBytes: data.length,
        format: "file",
        path: "bin/chaos",
        executable: true,
      },
    },
  },
];
async function cacheRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-chaos-")));
  roots.push(root);
  return join(root, "cache");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );

test("chaos: seeded cancellation storms preserve surviving callers and verified cache", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const directory = await cacheRoot();
    const opened = deferred(),
      release = deferred();
    let fetches = 0,
      cancelledDownload = false;
    const manager = new ManagedRuntimeCache(directory, async (_url, options) => {
      fetches++;
      options?.signal?.addEventListener("abort", () => {
        cancelledDownload = true;
      });
      opened.resolve();
      await release.promise;
      return new Response(data);
    });
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const outcomes = controllers.map((controller) =>
      settle(manager.resolve(assets, controller.signal, "linux-arm64"))
    );
    await opened.promise;
    const rng = random(seed);
    const shuffled = controllers.map((_, i) => i);
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(rng() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    const cancel = shuffled.slice(0, 24);
    for (const index of cancel)
      controllers[index]!.abort(new Error(`seed-${seed}-cancel-${index}`));
    release.resolve();
    const results = await Promise.all(outcomes);
    expect(results.filter((result) => result.ok)).toHaveLength(8);
    expect(cancelledDownload).toBe(false);
    expect(fetches).toBe(1);
    for (const [index, result] of results.entries()) {
      if (cancel.includes(index)) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe(controllers[index]!.signal.reason);
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) expect(await readFile(result.value.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
      }
    }
    const reused = await new ManagedRuntimeCache(directory, async () => {
      throw Error("cache miss");
    }).resolve(assets, undefined, "linux-arm64");
    expect(await readFile(reused.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
    expect((await readdir(directory)).filter((name) => name.startsWith(".runtime-"))).toEqual([]);
  }
}, 15_000);

test("chaos: concurrent waiters reject corrupt/interrupted downloads, then retry cleanly", async () => {
  const faults: Array<() => Response> = [
    () => {
      throw Error("synthetic DNS failure");
    },
    () => new Response("service unavailable", { status: 503 }),
    () => new Response(data.subarray(0, data.length - 1)),
    () => new Response(Buffer.concat([data, Buffer.from("overflow")])),
    () => new Response(Buffer.alloc(data.length, 0)),
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data.subarray(0, 31));
            controller.error(Error("synthetic reset"));
          },
        })
      ),
  ];
  for (const fault of faults) {
    const directory = await cacheRoot();
    let fetches = 0;
    const manager = new ManagedRuntimeCache(directory, async () =>
      ++fetches === 1 ? fault() : new Response(data)
    );
    const first = await Promise.all(
      Array.from({ length: 20 }, () => settle(manager.resolve(assets, undefined, "linux-arm64")))
    );
    expect(first.every((result) => !result.ok)).toBe(true);
    expect(fetches).toBe(1);
    expect(await readdir(directory)).toEqual([]);
    const second = await Promise.all(
      Array.from({ length: 20 }, () => manager.resolve(assets, undefined, "linux-arm64"))
    );
    expect(fetches).toBe(2);
    expect(new Set(second.map((value) => value.OPENTEAM_RUNTIME_CHAOS)).size).toBe(1);
    expect(await readFile(second[0]!.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
    expect((await readdir(directory)).filter((name) => name.startsWith(".runtime-"))).toEqual([]);
  }
}, 15_000);

test("chaos: independent installers race publication without corrupting shared bytes", async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const directory = await cacheRoot();
    const rng = random(seed),
      opened = Array.from({ length: 8 }, deferred),
      release = deferred();
    const managers = opened.map(
      (gate, index) =>
        new ManagedRuntimeCache(directory, async () => {
          gate.resolve();
          await release.promise;
          const width = 1 + Math.floor(rng() * 127);
          let position = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const end = Math.min(data.length, position + width + index);
                controller.enqueue(data.subarray(position, end));
                position = end;
                if (position === data.length) controller.close();
              },
            })
          );
        })
    );
    const jobs = managers.map((manager) => manager.resolve(assets, undefined, "linux-arm64"));
    await Promise.all(opened.map((gate) => gate.promise));
    release.resolve();
    const installed = await Promise.all(jobs);
    expect(new Set(installed.map((value) => value.OPENTEAM_RUNTIME_CHAOS)).size).toBe(1);
    expect(await readFile(installed[0]!.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
    expect((await readdir(directory)).filter((name) => name.startsWith(".runtime-"))).toEqual([]);
    expect(
      await new ManagedRuntimeCache(directory, async () => {
        throw Error("cache miss");
      }).resolve(assets, undefined, "linux-arm64")
    ).toEqual(installed[0]!);
  }
}, 15_000);

test("chaos: SIGKILL during a partial download never publishes incomplete executable bytes", async () => {
  for (const prefix of [1, 1024, data.length - 1]) {
    const directory = await cacheRoot();
    const source = `
      import { ManagedRuntimeCache } from ${JSON.stringify(new URL("./runtime-assets.ts", import.meta.url).pathname)};
      const data = Buffer.from(${JSON.stringify(data.toString("base64"))}, "base64");
      let delivered = false;
      setInterval(() => {}, 1000);
      await new ManagedRuntimeCache(${JSON.stringify(directory)}, async () => new Response(new ReadableStream({
        pull(controller) {
          if (!delivered) { delivered = true; controller.enqueue(data.subarray(0, ${prefix})); }
          else return new Promise(() => {});
        }
      }))).resolve(${JSON.stringify(assets)}, undefined, "linux-arm64");
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe" });
    let staging: string | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const entry = (await readdir(directory).catch(() => [])).find((name) =>
          name.startsWith(".runtime-")
        );
        if (
          entry &&
          (await stat(join(directory, entry, "download")).catch(() => undefined))?.size === prefix
        ) {
          staging = entry;
          break;
        }
        if (child.exitCode !== null) throw Error(await new Response(child.stderr).text());
        await Bun.sleep(5);
      }
      expect(staging).toBeString();
      child.kill("SIGKILL");
      await child.exited;
      // Crash leftovers are ignored, never treated as a published cache entry.
      expect(await readdir(directory)).toEqual([staging!]);
      const result = await new ManagedRuntimeCache(
        directory,
        async () => new Response(data)
      ).resolve(assets, undefined, "linux-arm64");
      expect(await readFile(result.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
      expect(result.OPENTEAM_RUNTIME_CHAOS!).not.toContain(staging!);
      const reopened = await new ManagedRuntimeCache(directory, async () => {
        throw Error("cache miss");
      }).resolve(assets, undefined, "linux-arm64");
      expect(reopened).toEqual(result);
      // A fresh SIGKILL staging directory is left alone to protect other installers.
      expect((await stat(join(directory, staging!, "download"))).size).toBe(prefix);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(join(directory, staging!), old, old);
      expect(
        await new ManagedRuntimeCache(directory, async () => {
          throw Error("cache miss");
        }).resolve(assets, undefined, "linux-arm64")
      ).toEqual(result);
      expect(await readdir(directory)).not.toContain(staging!);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }
}, 20_000);

test("staging cleanup preserves active installs, unrelated files, symlinks and published runtimes", async () => {
  const directory = await cacheRoot();
  await mkdir(directory);
  const active = await mkdtemp(join(directory, ".runtime-"));
  const stale = await mkdtemp(join(directory, ".runtime-"));
  const unrelated = join(directory, "operator-owned");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "keep"), "synthetic");
  const link = join(directory, ".runtime-Ab12Cd");
  await symlink(unrelated, link);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await utimes(unrelated, old, old);
  const manager = new ManagedRuntimeCache(directory, async () => new Response(data));
  const installed = await manager.resolve(assets, undefined, "linux-arm64");
  expect(await lstat(active)).toBeDefined();
  expect(await lstat(stale).catch(() => undefined)).toBeUndefined();
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("synthetic");
  expect(await readFile(installed.OPENTEAM_RUNTIME_CHAOS!)).toEqual(data);
});
