import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const directory = resolve(process.env.SEND_LIFECYCLE_DIR ?? resolve(import.meta.dir, "../../../output/desktop-send-motion/lifecycle"));
await mkdir(directory, {recursive: true});
// Each run has a disposable journal, so recorded retries cannot touch real accounts.
await rm(join(directory, "profile"), {recursive: true, force: true});
await rm(join(directory, "results.json"), {force: true});
const server = await createServer({root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"), server: {port: 0, strictPort: false}});
try {
  await server.listen();
  const child = Bun.spawn([createRequire(import.meta.url)("electron") as string,
    resolve(import.meta.dir, "../test/browser/message-send-lifecycle-runner.cjs")], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: undefined, SEND_LIFECYCLE_DIR: directory,
      SEND_LIFECYCLE_URL: `${server.resolvedUrls!.local[0]}test/browser/message-send-lifecycle.html${process.env.SEND_LIFECYCLE_BAR_RECORD === "1" ? "?retry-bar-recording=1" : ""}`},
    stdout: "inherit", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 90_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if(code) throw Error(`Electron lifecycle test failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if(result.error) throw Error(result.error);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await server.close();
}
