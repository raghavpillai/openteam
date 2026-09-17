import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-sidebar-parity-"));
const screenshot = join(tmpdir(), "openteam-sidebar-parity.png");
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const url = `${server.resolvedUrls!.local[0]}test/browser/sidebar-parity.html`;
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/sidebar-parity-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        SIDEBAR_TEST_DIR: directory,
        SIDEBAR_TEST_URL: url,
        SIDEBAR_TEST_SCREENSHOT: screenshot,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 45_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Screenshot: ${screenshot}`);
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
