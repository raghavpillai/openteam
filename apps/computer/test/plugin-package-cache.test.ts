import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PluginPackageCache } from "../src/plugin-package-cache";

test("binary packages are bounded by decoded bytes and materialize losslessly", async () => {
  const root = await mkdtemp(join(tmpdir(), "binary-package-cache-"));
  try {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x9f);
    const encoded = bytes.toString("base64");
    expect(encoded.length).toBeGreaterThan(20 * 1024 * 1024);
    const cache = new PluginPackageCache(root);
    const resolved = await cache.resolve({ command: "bun", args: ["${PLUGIN_ROOT}/server.mjs"], packageFiles: { "server.mjs": "export {};" }, packageBinaryFiles: { "binary.br": encoded } }) as { args: string[] };
    const path = resolved.args[0]!.replace(/server\.mjs$/, "binary.br");
    expect(await readFile(path)).toEqual(bytes);
    await expect(cache.resolve({ packageBinaryFiles: { "bad.br": "%%%=" } })).rejects.toThrow("encoding");
    await expect(cache.resolve({ packageFiles: { "same": "text" }, packageBinaryFiles: { "same": "YQ==" } })).rejects.toThrow("Duplicate");
    await expect(cache.resolve({ packageFiles: { "large": "x".repeat(5 * 1024 * 1024) }, packageBinaryFiles: { "large.br": encoded } })).rejects.toThrow("20 MB");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged local MCP preserves arguments, cwd, environment and tool changes across restarts", async () => {
  // Run the real transport outside Bun's test-runner subprocess shim.
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/packaged-manager-smoke.ts")],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(stderr).toBe("");
  expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "" });
}, 15_000);
