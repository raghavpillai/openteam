import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-reaction-order-"));
const output = process.env.REACTION_TEST_OUTPUT ?? join(directory, "results.json");
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  cacheDir: join(directory, "vite-cache"),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, hmr: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/reaction-order-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        REACTION_TEST_PROFILE: join(directory, "profile"),
        REACTION_TEST_OUTPUT: output,
        REACTION_TEST_URL: `${server.resolvedUrls!.local[0]}test/browser/reaction-order.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  try {
    console.log(await readFile(output, "utf8"));
  } catch {
    console.error(stderr);
  }
  if (code) process.exitCode = code;
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
