import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-window-activity-"));
const output = resolve(import.meta.dir, "../../../output/window-activity");
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  cacheDir: join(directory, "vite-cache"),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await mkdir(output, { recursive: true });
  const preload = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/preload/index.ts")],
    outdir: directory, naming: "preload.cjs", target: "node", format: "cjs", external: ["electron"],
  });
  if (!preload.success) throw Error(`Preload build failed: ${preload.logs.join("\n")}`);
  if (process.argv.includes("--sync")) {
    const main = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/main/notifications.ts")],
      outdir: directory, naming: "notifications.cjs", target: "node", format: "cjs" });
    if (!main.success) throw Error("Notification manager build failed");
  }
  {
    const main = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/main/window-activity.ts")],
      outdir: directory, naming: "window-activity.cjs", target: "node", format: "cjs" });
    if (!main.success) throw Error("Native activity helper build failed");
  }
  if (process.argv.includes("--native")) {
    await appendFile(join(directory, "preload.cjs"), `\nrequire('electron').contextBridge.exposeInMainWorld('activityQA', {
      cover:()=>require('electron').ipcRenderer.send('qa:cover'),
      restore:()=>require('electron').ipcRenderer.send('qa:restore'),
      hide:()=>require('electron').ipcRenderer.send('qa:hide'),
      quit:()=>require('electron').ipcRenderer.send('qa:quit')
    });\n`);
  }
  await server.listen();
  const child = Bun.spawn([require("electron") as string, resolve(import.meta.dir, "../test/browser/window-activity-runner.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, WINDOW_ACTIVITY_DIR: directory, WINDOW_ACTIVITY_OUTPUT: output,
      WINDOW_ACTIVITY_NATIVE: process.argv.includes("--native") ? "1" : undefined,
      WINDOW_ACTIVITY_SYNC: process.argv.includes("--sync") ? "1" : undefined,
      WINDOW_ACTIVITY_URL: `${server.resolvedUrls!.local[0]}test/browser/${process.argv.includes("--sync") ? "window-sync" : "window-activity"}.html${process.argv.includes("--native") ? "?native" : ""}` },
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), process.argv.includes("--native") ? 600_000 : 120_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw Error(`Electron failed: ${stderr}`);
  console.log(await readFile(join(directory, "results.json"), "utf8"));
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
