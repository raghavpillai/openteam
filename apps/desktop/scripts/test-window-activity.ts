import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-window-activity-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  const preload = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/preload/index.ts")],
    outdir: directory, naming: "preload.cjs", target: "node", format: "cjs", external: ["electron"],
  });
  if (!preload.success) throw Error(`Preload build failed: ${preload.logs.join("\n")}`);
  await server.listen();
  const child = Bun.spawn([require("electron") as string, resolve(import.meta.dir, "../test/browser/window-activity-runner.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, WINDOW_ACTIVITY_DIR: directory,
      WINDOW_ACTIVITY_URL: `${server.resolvedUrls!.local[0]}test/browser/window-activity.html` },
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw Error(`Electron failed: ${stderr}`);
  console.log(await readFile(join(directory, "results.json"), "utf8"));
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
