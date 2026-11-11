import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "openteam-desktop-style-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  cacheDir: join(directory, "vite"),
  optimizeDeps: { include: ["xlsx", "mammoth"] },
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron") as string,
      resolve(import.meta.dir, "../test/browser/desktop-style-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        DESKTOP_STYLE_DIR: directory,
        DESKTOP_STYLE_URL: `${server.resolvedUrls!.local[0]}test/browser/desktop-style-app.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 70_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw Error(`Desktop style checks failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (result.error) throw Error(result.error);
} finally {
  await server.close();
  await rm(directory, { force: true, recursive: true });
}
