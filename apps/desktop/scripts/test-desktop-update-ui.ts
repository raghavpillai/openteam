import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const desktopRoot = resolve(import.meta.dir, "..");
const artifacts = resolve(desktopRoot, "../../output/desktop-update-ui");
const directory = await mkdtemp(join(tmpdir(), "openteam-update-ui-"));
const electron = createRequire(import.meta.url)("electron") as string;
const server = await createServer({
  root: desktopRoot,
  configFile: join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("UI fixture server did not start");
  const url = `http://127.0.0.1:${address.port}/test/browser/desktop-update.html`;
  await mkdir(artifacts, { recursive: true });
  const runner = join(directory, "main.cjs");
  await writeFile(
    runner,
    await readFile(join(desktopRoot, "test/browser/desktop-update-driver.cjs"))
  );
  const child = Bun.spawn([electron, runner, url, artifacts], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "inherit",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Update UI checks failed: ${stderr}`);
  console.log(await readFile(join(artifacts, "results.json"), "utf8"));
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
