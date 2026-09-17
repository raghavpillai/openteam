/** Render only our synthetic fixture; never connects to or records an installed app. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "vite";

const desktop = resolve(import.meta.dir, "..");
const output = resolve(
  process.argv[2] ?? resolve(desktop, "../../output/ui-audit/template-motion")
);
await mkdir(output, { recursive: true });
await build({
  root: desktop,
  configFile: resolve(desktop, "vite.config.ts"),
  build: {
    outDir: resolve(output, "fixture-build"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(desktop, "test/browser/pixel-motion.html") },
  },
});
const fixture = resolve(output, "fixture-build/test/browser/pixel-motion.html");
await writeFile(
  fixture,
  (await readFile(fixture, "utf8")).replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">`
  )
);
const require = createRequire(import.meta.url);
const electron = require("electron") as string;
for (const { reduced, scale } of [
  { reduced: false, scale: 1 },
  { reduced: true, scale: 1 },
  { reduced: false, scale: 2 },
  { reduced: true, scale: 2 },
]) {
  const child = Bun.spawn(
    [
      electron,
      resolve(desktop, "test/browser/template-motion-runner.cjs"),
      output,
      `--scale=${scale}`,
      ...(reduced ? ["--reduced"] : []),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdout: "pipe", stderr: "pipe" }
  );
  const timeout = setTimeout(() => child.kill(), 60_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  await writeFile(
    resolve(output, `${reduced ? "reduced-tests" : "renderer-tests"}-${scale}x.log`),
    stdout + stderr
  );
  if (code !== 0) throw new Error(`Template renderer checks failed (${code}): ${stderr}`);
  process.stdout.write(stdout);
}
