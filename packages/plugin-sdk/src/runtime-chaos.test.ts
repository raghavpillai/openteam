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
test("SIGKILL during a partial download never publishes incomplete executable bytes", async () => {
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
