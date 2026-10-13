import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
const directory = resolve(process.env.TAILSCALE_QA_DIR || "../../artifacts/tailscale-settings-qa");
await mkdir(directory, { recursive: true });
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
      resolve(import.meta.dir, "../test/browser/tailscale-settings-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        TAILSCALE_QA_DIR: directory,
        TAILSCALE_QA_URL: `${server.resolvedUrls!.local[0]}test/browser/tailscale-settings.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 40_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(stderr);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if (result.error) throw new Error(result.error);
  for (const report of result.reports) console.log(`PASS ${report}`);
  console.log(`Screenshot: ${join(directory, "settings.png")}`);
} finally {
  await server.close();
}
