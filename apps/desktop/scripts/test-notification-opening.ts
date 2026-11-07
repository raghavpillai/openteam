import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "openteam-notification-opening-"));
const server = await createServer({
  root,
  cacheDir: join(directory, "vite-cache"),
  configFile: join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
try {
  for (const [entry, output] of [
    ["src/preload/index.ts", "preload.cjs"],
    ["src/main/notifications.ts", "notifications.cjs"],
  ] as const) {
    const build = await Bun.build({
      entrypoints: [join(root, entry)],
      target: "node",
      format: "cjs",
      external: ["electron"],
      outdir: directory,
      naming: output,
    });
    if (!build.success) throw new AggregateError(build.logs, "Notification test build failed");
  }
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not start");
  const child = Bun.spawn(
    [
      createRequire(import.meta.url)("electron") as string,
      join(root, "test/browser/notification-opening-runner.cjs"),
      `http://127.0.0.1:${address.port}/test/browser/notification-opening.html`,
      directory,
      join(root, "src/preload/index.ts"),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdout: "inherit",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill(), 120000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (code) throw new Error(`Notification fixture exited ${code}: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (result.error) throw new Error(result.error);
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
