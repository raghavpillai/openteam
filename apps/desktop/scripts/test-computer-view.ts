import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-computer-view-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/computer-view-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        COMPUTER_VIEW_DIR: directory,
        COMPUTER_VIEW_URL: `${server.resolvedUrls!.local[0]}test/browser/screen-reference.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 30_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (
    result.reports.length !== 2 ||
    result.reports.some((report: { fullWindow?: boolean }) => !report.fullWindow)
  )
    throw new Error("Computer view must fill the window outside the animated inspector");
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
