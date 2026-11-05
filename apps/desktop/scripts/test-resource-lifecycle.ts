import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-resource-lifecycle-"));
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const preload = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/preload/index.ts")],
    outdir: directory,
    naming: "preload.cjs",
    external: ["electron"],
    target: "node",
    format: "cjs",
  });
  if (!preload.success) throw new Error(preload.logs.join("\n"));
  const renderer = join(directory, "renderer");
  await build({
    root: resolve(import.meta.dir, ".."),
    configFile: resolve(import.meta.dir, "../vite.config.ts"),
    resolve: {
      alias: [
        {
          find: "@novnc/novnc",
          replacement: resolve(import.meta.dir, "../test/browser/resource-lifecycle-vnc.ts"),
        },
      ],
    },
    build: {
      outDir: renderer,
      emptyOutDir: true,
      rolldownOptions: {
        input: resolve(import.meta.dir, "../test/browser/resource-lifecycle.html"),
      },
    },
    logLevel: "warn",
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const filePath = resolve(renderer, "." + decodeURIComponent(new URL(request.url).pathname));
      if (!filePath.startsWith(renderer + "/")) return new Response(null, { status: 404 });
      const file = Bun.file(filePath);
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    },
  });
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/resource-lifecycle-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        RESOURCE_LIFECYCLE_DIR: directory,
        RESOURCE_LIFECYCLE_URL: `${server.url}test/browser/resource-lifecycle.html`,
      },
      stdout: "inherit",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 120_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (code || result.error) throw new Error(result.error ?? stderr);
} finally {
  server?.stop(true);
  await rm(directory, { recursive: true, force: true });
}
