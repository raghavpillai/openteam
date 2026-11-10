import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const directory =
  process.env.COMPOSER_CARET_DIR ?? (await mkdtemp(join(tmpdir(), "openteam-caret-")));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
let passed = false;
try {
  await server.listen();
  const child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron") as string,
      resolve(import.meta.dir, "../test/browser/composer-caret-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        COMPOSER_CARET_DIR: directory,
        COMPOSER_CARET_URL: `${server.resolvedUrls!.local[0]}test/browser/composer-button-parity.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill(), 30_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (code) throw Error(`Composer caret check failed (screenshots: ${directory}): ${stderr}`);
  const { reports } = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  for (const report of reports) console.log(`PASS ${report}`);
  passed = true;
} finally {
  await server.close();
  if (passed && !process.env.COMPOSER_CARET_DIR)
    await rm(directory, { recursive: true, force: true });
}
