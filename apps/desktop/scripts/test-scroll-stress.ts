import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "openteam-scroll-stress-"));
const output = resolve(
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    resolve(import.meta.dir, "../../../output/chat-scroll-stress")
);
const reduced = process.argv.includes("--reduced-motion");
const replaceModule = process.argv.find((arg) => arg.startsWith("--replace-module="))?.slice(17);
const withSource = process.argv.find((arg) => arg.startsWith("--with-source="))?.slice(14);
if (Boolean(replaceModule) !== Boolean(withSource)) throw Error("Supply both control source paths");
const server = await createServer({
  plugins:
    replaceModule && withSource
      ? [
          {
            name: "scroll-regression-control",
            enforce: "pre",
            load(id) {
              if (id === resolve(replaceModule)) return readFile(resolve(withSource), "utf8");
            },
          },
        ]
      : [],
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  cacheDir: join(temporary, "cache"),
  server: { port: 0, hmr: false },
});
await mkdir(output, { recursive: true });
try {
  await server.listen();
  const runner = await readFile(
    resolve(import.meta.dir, "../test/browser/scroll-stress-runner.cjs"),
    "utf8"
  );
  await writeFile(
    join(temporary, "main.cjs"),
    `const configuration=${JSON.stringify({ url: server.resolvedUrls!.local[0] + "test/browser/scroll-stress.html", output, reduced, focusOnly: process.argv.includes("--focus-only"), mode: process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) })};\n` +
      runner
  );
  const child = Bun.spawn([require("electron") as string, join(temporary, "main.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "inherit",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 300000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code) throw new Error(`Scroll stress failed (${code}): ${stderr.slice(-2000)}`);
} finally {
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
