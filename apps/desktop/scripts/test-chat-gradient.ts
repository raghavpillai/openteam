import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-chat-gradient-"));
const artifacts = resolve(
  process.env.CHAT_GRADIENT_ARTIFACTS ?? join(tmpdir(), "openteam-chat-gradient")
);
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const child = Bun.spawn(
    [
      require("electron") as string,
      resolve(import.meta.dir, "../test/browser/chat-gradient-runner.cjs"),
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CHAT_GRADIENT_DIR: directory,
        CHAT_GRADIENT_ARTIFACTS: artifacts,
        CHAT_GRADIENT_URL: `${server.resolvedUrls!.local[0]}test/browser/chat-gradient.html`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 60_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(result, null, 2));
  console.log(`Screenshots: ${artifacts}`);
  if (result.error) throw new Error(result.error);
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
