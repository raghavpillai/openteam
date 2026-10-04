import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "openteam-composer-buttons-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron") as string,
      resolve(import.meta.dir, "../test/browser/composer-button-parity-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        COMPOSER_PARITY_DIR: directory,
        COMPOSER_PARITY_URL: `${server.resolvedUrls!.local[0]}test/browser/composer-button-parity.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill(), 30_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (code) throw Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if (result.error) throw Error(result.error);
  for (const report of result.reports)
    console.log(
      `PASS ${report.theme} ${report.configured ? "configured" : "disabled"}: empty, draft, and cleared composer`
    );
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
