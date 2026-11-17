import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dir, "..");
const stress = process.argv.includes("--stress");
const artifacts = resolve(
  root,
  stress ? "../../output/update-queue-chaos/ui-stress" : "../../output/update-queue-ui"
);
const directory = await mkdtemp(join(tmpdir(), "openteam-queue-ui-"));
const electron = createRequire(import.meta.url)("electron") as string;
const server = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("UI fixture did not start");
  await mkdir(artifacts, { recursive: true });
  const runner = join(directory, "main.cjs");
  await writeFile(
    runner,
    await readFile(
      join(
        root,
        stress
          ? "test/browser/update-queue-stress-driver.cjs"
          : "test/browser/update-queue-driver.cjs"
      )
    )
  );
  const child = Bun.spawn(
    [
      electron,
      runner,
      `http://127.0.0.1:${address.port}/test/browser/update-queue.html`,
      artifacts,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdout: "inherit", stderr: "pipe" }
  );
  const timeout = setTimeout(() => child.kill(), stress ? 120_000 : 90_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Update queue UI checks failed: ${stderr}`);
  console.log(await readFile(join(artifacts, "results.json"), "utf8"));
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
